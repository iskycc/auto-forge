import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CreateRunBatchRecord } from "@autoforge/application";
import { defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";
import {
  SqlitePublicSuiteExecutionRepository,
  PostgresPublicSuiteExecutionRepository,
} from "../src/public-suite-execution";
import { SqliteExecutionControlRepository } from "../src/sqlite-execution-control";
import { PostgresExecutionControlRepository } from "../src/postgres-execution-control";
import { createAttemptLogStore } from "../src/attempt-log-store";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-10-27T02:00:00.000Z";

for (const adapter of ["sqlite", "postgres"] as const)
  describe.skipIf(adapter === "postgres" && !postgresUrl)(
    `${adapter} public task execution`,
    () => {
      it("keeps independent publisher grants, blocks revocation/disabled owners and cascades task deletion", async () => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.publisher.id, now);
          await h.links.publish(h.suite.id, h.visitor.id, now);
          await h.links.revoke(h.suite.id, h.publisher.id, now);
          expect(await h.links.publisher(h.suite.id, h.publisher.id)).toBeNull();
          expect(await h.links.publisher(h.suite.id, h.visitor.id)).toMatchObject({
            id: h.visitor.id,
          });
          await h.query("UPDATE users SET status='disabled' WHERE id=?", [h.visitor.id]);
          expect(await h.links.publisher(h.suite.id, h.visitor.id)).toBeNull();
          await h.query("DELETE FROM case_suites WHERE id=?", [h.suite.id]);
          expect(
            await h.query("SELECT * FROM public_suite_execution_links WHERE suite_id=?", [
              h.suite.id,
            ]),
          ).toHaveLength(0);
        });
      });
      it("atomically publishes the result and preserves sharer, initiator and first terminator", async () => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.publisher.id, now);
          const record = h.record();
          const batch = await h.batches.create(record);
          expect(batch.publicExecution).toEqual({ publisher: h.publisher, initiator: h.visitor });
          expect(batch.publicExecution).not.toHaveProperty("requestKey");
          expect(
            await h.query("SELECT batch_id FROM public_batch_access WHERE batch_id=?", [batch.id]),
          ).toHaveLength(1);
          expect(
            await h.links.replay(h.suite.id, h.publisher.id, record.publicExecution!.requestKey),
          ).toBe(batch.id);
          const actor = { ...h.visitor, username: "actual-terminator" };
          await h.executions.terminateBatch({
            batchId: batch.id,
            actorId: actor.id,
            actor,
            reason: "stop",
            eventId: randomUUID(),
            requestedAt: now,
          });
          await h.executions.terminateBatch({
            batchId: batch.id,
            actorId: h.publisher.id,
            actor: h.publisher,
            reason: "again",
            eventId: randomUUID(),
            requestedAt: now,
          });
          expect((await h.batches.getMetadata(batch.id))?.terminatedBy).toEqual(actor);
          const state = await h.links.executions(h.suite.id);
          expect(state.active).toHaveLength(0);
          expect(state.recent[0]).toMatchObject({
            id: batch.id,
            publisher: h.publisher.username,
            requestedBy: h.visitor.username,
            terminatedBy: "actual-terminator",
            publicExecution: true,
            progressPath: `/Execution?BatchId=${batch.id}`,
          });
          await expect(
            h.batches.create({ ...record, id: randomUUID(), runs: [] }),
          ).rejects.toMatchObject({ code: "PUBLIC_EXECUTION_REPLAY", details: batch.id });
        });
      });
      it("serializes concurrent public starts and keeps a durable delayed batch", async () => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.publisher.id, now);
          const first = h.record();
          const second = h.record();
          const outcomes = await Promise.allSettled([
            h.batches.create(first),
            h.batches.create(second),
          ]);
          expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
            reason: { code: "PUBLIC_SUITE_EXECUTION_ACTIVE" },
          });
          const state = await h.links.executions(h.suite.id);
          expect(state.active).toHaveLength(1);
          expect(state.active[0]?.scheduledFor).toBe("2026-10-27T03:00:00.000Z");
          expect(JSON.stringify(state)).not.toContain("environmentVariables");
          expect(JSON.stringify(state)).not.toContain("requestKey");
        });
      });
      it("reads every execution environment from the immutable batch snapshot, including older batches", async () => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.publisher.id, now);
          const record = h.record();
          const addresses = ["10.0.0.21", "2001:db8::21"];
          record.adapterRuntimeSnapshot!.environmentAddresses = addresses;
          record.policy = {
            executor: "testng",
            concurrency: 1,
            runnerLabels: [],
            artifactPatterns: [],
          };
          const batch = await h.batches.create(record);
          expect((await h.batches.getMetadata(batch.id))?.environmentAddresses).toEqual(addresses);
          expect((await h.batches.getSummary(batch.id))?.environmentAddresses).toEqual(addresses);
          expect((await h.links.executions(h.suite.id)).active[0]?.environmentAddresses).toEqual(
            addresses,
          );
          expect((await h.links.batch(h.suite.id, batch.id))?.environmentAddresses).toEqual(
            addresses,
          );
          const { publicExecution: _publicExecution, ...ordinary } = h.record();
          void _publicExecution;
          ordinary.adapterRuntimeSnapshot!.environmentAddresses = ["legacy.internal"];
          const legacy = await h.batches.create(ordinary);
          expect((await h.batches.getMetadata(legacy.id))?.environmentAddresses).toEqual([
            "legacy.internal",
          ]);
          expect((await h.batches.getMetadata(batch.id))?.environmentAddresses).toEqual(addresses);
        });
      });
      it("rechecks grants inside creation and detects an existing ordinary execution", async () => {
        await withHarness(adapter, async (h) => {
          await expect(h.batches.create(h.record())).rejects.toMatchObject({
            code: "PUBLIC_SUITE_LINK_NOT_FOUND",
          });
          await h.links.publish(h.suite.id, h.publisher.id, now);
          const { publicExecution: _context, ...ordinary } = h.record();
          void _context;
          const batch = await h.batches.create(ordinary);
          await expect(h.batches.create(h.record())).rejects.toMatchObject({
            code: "PUBLIC_SUITE_EXECUTION_ACTIVE",
          });
          expect((await h.links.executions(h.suite.id)).active[0]).toMatchObject({
            id: batch.id,
            publicExecution: false,
            progressPath: null,
          });
          await h.links.revoke(h.suite.id, h.publisher.id, now);
          await expect(h.batches.create(h.record())).rejects.toMatchObject({
            code: "PUBLIC_SUITE_LINK_NOT_FOUND",
          });
        });
      });
    },
  );

async function withHarness(
  adapter: "sqlite" | "postgres",
  test: (h: Awaited<ReturnType<typeof createHarness>>) => Promise<void>,
) {
  const h = await createHarness(adapter);
  try {
    await test(h);
  } finally {
    await h.dispose();
  }
}

async function createHarness(adapter: "sqlite" | "postgres") {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-public-suite-"));
  const sqlite =
    adapter === "sqlite"
      ? createSqliteDatabase({
          databasePath: join(directory, "db.sqlite"),
          migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
        })
      : undefined;
  const postgres =
    adapter === "postgres"
      ? createPostgresDatabase({
          connectionString: postgresUrl!,
          migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
          poolMax: 4,
        })
      : undefined;
  await postgres?.ready;
  const query = async (statement: string, parameters: string[] = []) =>
    sqlite
      ? sqlite.client.prepare(statement).reader
        ? (sqlite.client.prepare(statement).all(...parameters) as Record<string, unknown>[])
        : (sqlite.client.prepare(statement).run(...parameters), [])
      : ((
          await postgres!.pool.query(
            statement.replace(
              /\?/g,
              (() => {
                let index = 0;
                return () => `$${++index}`;
              })(),
            ),
            parameters,
          )
        ).rows as Record<string, unknown>[]);
  const publisher = {
    id: randomUUID(),
    username: `owner-${randomUUID()}`,
    source: "local" as const,
  };
  const visitor = {
    id: randomUUID(),
    username: `visitor-${randomUUID()}`,
    source: "local" as const,
  };
  for (const actor of [publisher, visitor])
    await query(
      "INSERT INTO users(id,username,normalized_username,display_name,source,status,created_at,updated_at) VALUES (?,?,?,?,'local','active',?,?)",
      [actor.id, actor.username, actor.username, actor.username, now, now],
    );
  const suites = sqlite
    ? new SqliteCaseSuiteRepository(sqlite)
    : new PostgresCaseSuiteRepository(postgres!);
  const suite = await suites.create({
    id: randomUUID(),
    name: "公开执行契约",
    createdAt: now,
    policy: defaultCaseSuiteExecutionPolicy,
  });
  const links = sqlite
    ? new SqlitePublicSuiteExecutionRepository(sqlite)
    : new PostgresPublicSuiteExecutionRepository(postgres!);
  const batches = sqlite
    ? new SqliteRunBatchRepository(sqlite)
    : new PostgresRunBatchRepository(postgres!);
  const logs = createAttemptLogStore(join(directory, "logs"));
  const executions = sqlite
    ? new SqliteExecutionControlRepository(sqlite, logs)
    : new PostgresExecutionControlRepository(postgres!, logs);
  function record(): CreateRunBatchRecord {
    return {
      id: randomUUID(),
      suiteId: suite.id,
      suiteName: suite.name,
      suiteVersion: 1,
      expectedSuiteRevision: suite.revision,
      requestedBy: { username: visitor.username, source: visitor.source },
      publicExecution: { publisher, initiator: visitor, requestKey: randomUUID() },
      retryLimit: 0,
      environmentVariables: [],
      runnerIds: [],
      adapterRuntimeSnapshot: { suiteName: "suite", testName: "test", environmentAddresses: [] },
      runs: [
        {
          id: randomUUID(),
          caseDefinitionId: randomUUID(),
          caseVersion: 1,
          displayName: "Wallet",
          className: "example.WalletTest",
        },
      ],
      scheduledFor: "2026-10-27T03:00:00.000Z",
      createdAt: now,
    };
  }
  return {
    query,
    publisher,
    visitor,
    suite,
    links,
    batches,
    executions,
    record,
    async dispose() {
      try {
        await query("DELETE FROM run_batches WHERE suite_id=?", [suite.id]);
        await query("DELETE FROM case_suites WHERE id=?", [suite.id]);
        for (const actor of [publisher, visitor])
          await query("DELETE FROM users WHERE id=?", [actor.id]);
      } finally {
        sqlite?.close();
        await postgres?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
