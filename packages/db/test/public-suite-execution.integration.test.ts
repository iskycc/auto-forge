import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AiAnalysisService,
  resolveAutomaticAiAuthority,
  type CreateRunBatchRecord,
} from "@autoforge/application";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import { SqliteIdentityAccessRepository } from "../src/sqlite-identity-access";
import { PostgresIdentityAccessRepository } from "../src/postgres-identity-access";
import { SqliteAiAnalysisRepository } from "../src/sqlite-ai-analysis";
import { PostgresAiAnalysisRepository } from "../src/postgres-ai-analysis";
import { defaultCaseSuiteExecutionPolicy, builtInRoleDefinitions } from "@autoforge/domain";
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
      it("authorizes automatic AI with the public publisher and retains the actual initiator", async () => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.publisher.id, now);
          await h.identities.ensureBuiltInRoles(builtInRoleDefinitions, now);
          await h.identities.assignSystemRole(
            h.publisher.id,
            builtInRoleDefinitions[0]!.id,
            h.publisher.id,
            now,
          );
          const record = h.record();
          const batch = await h.batches.create(record);
          await h.query("UPDATE run_batches SET status='failed',policy_json=? WHERE id=?", [
            JSON.stringify({ aiAnalysisAfterCompletion: true, aiAnalysisExecutionId: batch.id }),
            batch.id,
          ]);
          const configuration = aiModelConfigurationSchema.parse({
            enabled: true,
            baseUrl: "http://model/v1",
            modelId: "fixture",
          });
          const current = await h.ai.configuration();
          await h.ai.saveConfiguration(
            { revision: current.revision + 1, configuration, encryptedKey: null },
            current.revision,
          );
          const authority = await resolveAutomaticAiAuthority(h.identities, h.batches, batch.id);
          expect(authority.actor?.user.id).toBe(h.publisher.id);
          const service = new AiAnalysisService(
            h.ai,
            h.batches,
            { available: true, encrypt: () => "unused", decrypt: () => "unused" },
            { now: () => new Date(now) },
            { next: randomUUID },
          );
          const job = await service.createAutomatic(authority.actor!, batch.id);
          expect(job.requestedBy).toBe(h.publisher.id);
          expect((await h.batches.getMetadata(batch.id))?.requestedBy?.username).toBe(
            h.visitor.username,
          );
          expect((await h.batches.getMetadata(batch.id))?.publicExecution?.initiator).toEqual(
            h.visitor,
          );
          await h.identities.assignSystemRole(
            h.visitor.id,
            builtInRoleDefinitions[0]!.id,
            h.publisher.id,
            now,
          );
          await h.identities.removeSystemRole(h.publisher.id, builtInRoleDefinitions[0]!.id);
          const revoked = await resolveAutomaticAiAuthority(h.identities, h.batches, batch.id);
          expect(revoked.actor).toBeNull();
          expect(revoked.unavailableReason).toContain("分享人缺少当前 AI 或证据权限");
          expect(
            (await h.ai.view({ batchId: batch.id, jobId: job.id, limit: 10 }))?.job.requestedBy,
          ).toBe(h.publisher.id);
        });
      });
      it("persists one latest per-link environment record and rejects stale edits or execution snapshots", async () => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.publisher.id, now);
          expect(await h.links.environment(h.suite.id, h.publisher.id)).toMatchObject({
            revision: 0,
            change: null,
          });
          const addresses = ["10.0.0.21", "2001:db8::21"];
          const results = await Promise.allSettled(
            [h.publisher, h.visitor].map((actor) =>
              h.links.changeEnvironment(
                h.suite.id,
                h.publisher.id,
                { revision: 0, addresses },
                actor,
                now,
              ),
            ),
          );
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          const state = await h.links.environment(h.suite.id, h.publisher.id);
          expect(state).toMatchObject({ revision: 1, change: { addresses, modifiedAt: now } });
          for (const result of results)
            if (result.status === "rejected")
              expect(result.reason).toMatchObject({
                code: "PUBLIC_SUITE_ENVIRONMENT_REVISION_CONFLICT",
              });
          const stale = h.record();
          stale.publicExecution!.environmentRevision = 0;
          await expect(h.batches.create(stale)).rejects.toMatchObject({
            code: "PUBLIC_SUITE_ENVIRONMENT_REVISION_CONFLICT",
          });
          const current = h.record();
          current.publicExecution!.environmentRevision = 1;
          current.publicExecution!.environmentChange = state!.change;
          current.adapterRuntimeSnapshot!.environmentAddresses = addresses;
          expect(await h.batches.create(current)).toMatchObject({
            environmentAddresses: addresses,
            publicExecution: { environmentChange: state!.change },
          });
          await h.links.publish(h.suite.id, h.visitor.id, now);
          expect(await h.links.environment(h.suite.id, h.visitor.id)).toMatchObject({
            revision: 0,
            change: null,
          });
          expect(
            (await h.suites.getSummary(h.suite.id))!.policy.adapter.environmentAddresses,
          ).toEqual([]);
          expect(
            await h.links.changeEnvironment(
              h.suite.id,
              h.publisher.id,
              { revision: 1, addresses: null },
              h.visitor,
              now,
            ),
          ).toMatchObject({ revision: 2, change: { addresses: null, modifiedBy: h.visitor } });
          await h.links.revoke(h.suite.id, h.publisher.id, now);
          await expect(
            h.links.changeEnvironment(
              h.suite.id,
              h.publisher.id,
              { revision: 2, addresses },
              h.visitor,
              now,
            ),
          ).rejects.toMatchObject({ code: "PUBLIC_SUITE_ENVIRONMENT_REVISION_CONFLICT" });
        });
      });
      it("orders shared IP changes against simultaneous execution creation", async () => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.publisher.id, now);
          const record = h.record();
          record.publicExecution!.environmentRevision = 0;
          record.adapterRuntimeSnapshot!.environmentAddresses = ["10.0.0.1"];
          const [created, changed] = await Promise.allSettled([
            h.batches.create(record),
            h.links.changeEnvironment(
              h.suite.id,
              h.publisher.id,
              { revision: 0, addresses: ["10.0.0.2"] },
              h.visitor,
              now,
            ),
          ]);
          expect(changed.status).toBe("fulfilled");
          if (created.status === "fulfilled")
            expect(created.value.environmentAddresses).toEqual(["10.0.0.1"]);
          else
            expect(created.reason).toMatchObject({
              code: "PUBLIC_SUITE_ENVIRONMENT_REVISION_CONFLICT",
            });
          expect(await h.links.environment(h.suite.id, h.publisher.id)).toMatchObject({
            revision: 1,
            change: { addresses: ["10.0.0.2"] },
          });
        });
      });
      it("serializes public link maintenance with the task lock and leaves existing read grants intact", async () => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.visitor.id, now);
          await h.query(
            "UPDATE case_suites SET locked_by=?,locked_by_name=?,locked_at=? WHERE id=?",
            [h.publisher.id, "锁定人", now, h.suite.id],
          );
          await expect(h.links.publish(h.suite.id, h.visitor.id, now)).rejects.toMatchObject({
            code: "CASE_SUITE_LOCKED",
          });
          await expect(h.links.revoke(h.suite.id, h.visitor.id, now)).rejects.toMatchObject({
            code: "CASE_SUITE_LOCKED",
          });
          expect(await h.links.publisher(h.suite.id, h.visitor.id)).toMatchObject({
            id: h.visitor.id,
          });
          await h.links.publish(h.suite.id, h.publisher.id, now);
          await h.links.revoke(h.suite.id, h.publisher.id, now);
          expect(await h.links.publisher(h.suite.id, h.publisher.id)).toBeNull();
        });
      });

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
            initiator: h.visitor,
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
          const locked = await h.suites.setLock({
            suiteId: h.suite.id,
            expectedRevision: h.suite.revision,
            actorId: h.publisher.id,
            actorName: h.publisher.username,
            locked: true,
            updatedAt: now,
          });
          const savedTask = await h.suites.getSummary(h.suite.id);
          const record = h.record();
          record.expectedSuiteRevision = locked.revision;
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
          ordinary.expectedSuiteRevision = locked.revision;
          ordinary.adapterRuntimeSnapshot!.environmentAddresses = ["legacy.internal"];
          const legacy = await h.batches.create(ordinary);
          expect((await h.batches.getMetadata(legacy.id))?.environmentAddresses).toEqual([
            "legacy.internal",
          ]);
          expect((await h.batches.getMetadata(batch.id))?.environmentAddresses).toEqual(addresses);
          expect(await h.suites.getSummary(h.suite.id)).toEqual(savedTask);
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
      it.each([
        { first: ["10.0.0.1"], second: ["10.0.0.1"], conflict: true },
        { first: ["10.0.0.1", "10.0.0.2"], second: ["10.0.0.1"], conflict: true },
        { first: ["10.0.0.1"], second: ["10.0.0.2", "10.0.0.1"], conflict: true },
        { first: ["10.0.0.1", "10.0.0.2"], second: ["10.0.0.3", "10.0.0.2"], conflict: true },
        { first: ["2001:db8::1"], second: ["2001:0DB8:0:0:0:0:0:1"], conflict: true },
        { first: ["10.0.0.1"], second: ["::ffff:10.0.0.1"], conflict: true },
        { first: ["10.0.0.1"], second: ["10.0.0.10"], conflict: false },
        {
          first: ["10.0.0.1", "2001:db8::1"],
          second: ["10.0.0.2", "2001:db8::2"],
          conflict: false,
        },
      ])(
        "checks the complete environment sets $first / $second (conflict=$conflict)",
        async ({ first, second, conflict }) => {
          await withHarness(adapter, async (h) => {
            await h.links.publish(h.suite.id, h.publisher.id, now);
            const firstRecord = h.record();
            firstRecord.adapterRuntimeSnapshot!.environmentAddresses = first;
            const firstBatch = await h.batches.create(firstRecord);
            const nextRecord = h.record();
            nextRecord.adapterRuntimeSnapshot!.environmentAddresses = second;
            if (conflict)
              await expect(h.batches.create(nextRecord)).rejects.toMatchObject({
                code: "PUBLIC_SUITE_EXECUTION_ACTIVE",
                message: expect.stringContaining("环境"),
                details: { batchId: firstBatch.id, conflictingAddresses: expect.any(Array) },
              });
            else {
              const next = await h.batches.create(nextRecord);
              expect(next.environmentAddresses).toEqual(second);
              expect((await h.links.executions(h.suite.id)).active).toHaveLength(2);
            }
          });
        },
      );
      it.each([true, false])(
        "serializes simultaneous public starts (overlap=$overlap)",
        async (overlap) => {
          await withHarness(adapter, async (h) => {
            await h.links.publish(h.suite.id, h.publisher.id, now);
            await h.links.publish(h.suite.id, h.visitor.id, now);
            const records = [h.record(), h.record()];
            records[0]!.adapterRuntimeSnapshot!.environmentAddresses = ["10.0.0.1"];
            records[1]!.adapterRuntimeSnapshot!.environmentAddresses = [
              overlap ? "10.0.0.1" : "10.0.0.2",
            ];
            // Different publisher links share the same task-level environment guard.
            records[1]!.publicExecution!.publisher = h.visitor;
            // The repository still serializes public requests from older callers lacking revision.
            delete records[0]!.expectedSuiteRevision;
            delete records[1]!.expectedSuiteRevision;
            const results = await Promise.allSettled(
              records.map((record) => h.batches.create(record)),
            );
            expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
              overlap ? 1 : 2,
            );
            for (const result of results)
              if (result.status === "rejected")
                expect(result.reason).toMatchObject({ code: "PUBLIC_SUITE_EXECUTION_ACTIVE" });
          });
        },
      );
      it("checks every active batch beyond the public display window and preserves idempotent replay", async () => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.publisher.id, now);
          let oldestId = "";
          for (let index = 1; index <= 102; index++) {
            const { publicExecution: _context, ...ordinary } = h.record();
            void _context;
            // Put the hidden conflicting row past the first 100-row validation page.
            if (index === 1) ordinary.id = `z${ordinary.id}`;
            ordinary.adapterRuntimeSnapshot!.environmentAddresses = [`10.0.0.${index}`];
            ordinary.createdAt = new Date(Date.parse(now) + index * 1000).toISOString();
            const batch = await h.batches.create(ordinary);
            if (index === 1) oldestId = batch.id;
          }
          const record = h.record();
          record.adapterRuntimeSnapshot!.environmentAddresses = ["10.0.0.1"];
          await expect(h.batches.create(record)).rejects.toMatchObject({
            code: "PUBLIC_SUITE_EXECUTION_ACTIVE",
            details: { batchId: oldestId },
          });
          await h.query("UPDATE run_batches SET status='succeeded' WHERE id=?", [oldestId]);
          const created = await h.batches.create(record);
          expect(
            await h.links.replay(h.suite.id, h.publisher.id, record.publicExecution!.requestKey),
          ).toBe(created.id);
          await expect(h.batches.create(record)).rejects.toMatchObject({
            code: "PUBLIC_EXECUTION_REPLAY",
            details: created.id,
          });
        });
      });
      it.each([
        "queued",
        "dispatching",
        "scheduled",
        "running",
        "paused",
        "terminating",
        "succeeded",
        "failed",
        "cancelled",
      ] as const)("keeps environment occupancy until state %s has ended", async (state) => {
        await withHarness(adapter, async (h) => {
          await h.links.publish(h.suite.id, h.publisher.id, now);
          const first = h.record();
          first.adapterRuntimeSnapshot!.environmentAddresses = ["10.0.0.1"];
          const batch = await h.batches.create(first);
          await h.query(
            "UPDATE run_batches SET status=?,pause_requested_at=?,cancel_requested_at=? WHERE id=?",
            [
              state === "paused" || state === "terminating" ? "running" : state,
              state === "paused" ? now : null,
              state === "terminating" ? now : null,
              batch.id,
            ],
          );
          const second = h.record();
          second.adapterRuntimeSnapshot!.environmentAddresses = ["10.0.0.1"];
          if (["succeeded", "failed", "cancelled"].includes(state))
            await expect(h.batches.create(second)).resolves.toMatchObject({ id: second.id });
          else
            await expect(h.batches.create(second)).rejects.toMatchObject({
              code: "PUBLIC_SUITE_EXECUTION_ACTIVE",
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
  const query = async (statement: string, parameters: (string | null)[] = []) =>
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
  const identities = sqlite
    ? new SqliteIdentityAccessRepository(sqlite)
    : new PostgresIdentityAccessRepository(postgres!);
  const ai = sqlite
    ? new SqliteAiAnalysisRepository(sqlite)
    : new PostgresAiAnalysisRepository(postgres!);
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
    suites,
    links,
    identities,
    ai,
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
