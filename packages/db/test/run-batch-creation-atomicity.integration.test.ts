import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import type { CreateRunBatchRecord } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-10-30T12:00:00.000Z";

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(
    `${dialect} batch creation acceptance`,
    () => {
      it("commits the audit, runs and durable dispatch before returning a queued acknowledgement", async () => {
        await withRepository(dialect, async ({ repository, query }) => {
          const record = batchRecord();
          vi.spyOn(repository, "getSummary").mockRejectedValue(new Error("No post-commit queries"));
          const batch = await repository.create(record);
          expect(batch).toMatchObject({
            id: record.id,
            status: "queued",
            totalRuns: 1,
            queuedRuns: 1,
            assignedRuns: 0,
            scheduledFor: now,
            requestedBy: { username: "launcher", source: "local" },
          });
          expect(repository.getSummary).not.toHaveBeenCalled();
          expect(
            await query("SELECT action,resource_id,request_id FROM audit_events WHERE id=?", [
              record.creationAudit!.id,
            ]),
          ).toEqual([
            {
              action: "run_batch.create",
              resource_id: record.id,
              request_id: record.creationAudit!.requestId,
            },
          ]);
          expect(
            await query(
              `SELECT run_id FROM ${dialect === "sqlite" ? "queue_jobs" : "transactional_outbox"} WHERE message_id=?`,
              [record.dispatchJob!.messageId],
            ),
          ).toEqual([{ run_id: record.id }]);
        });
      });

      it("rolls back the batch, runs, events and dispatch if its audit cannot be saved", async () => {
        await withRepository(dialect, async ({ repository, query }) => {
          const record = batchRecord();
          // A real database constraint fails at the final audit write, after all batch writes.
          record.creationAudit!.projectId = `missing-project-${randomUUID()}`;
          await expect(repository.create(record)).rejects.toThrow();
          expect(await query("SELECT id FROM run_batches WHERE id=?", [record.id])).toEqual([]);
          expect(
            await query("SELECT id FROM execution_runs WHERE batch_id=?", [record.id]),
          ).toEqual([]);
          expect(
            await query("SELECT id FROM run_batch_status_events WHERE batch_id=?", [record.id]),
          ).toEqual([]);
          expect(
            await query(
              `SELECT run_id FROM ${dialect === "sqlite" ? "queue_jobs" : "transactional_outbox"} WHERE message_id=?`,
              [record.dispatchJob!.messageId],
            ),
          ).toEqual([]);
        });
      });
    },
  );
}

it("does not leave a hidden batch or dispatch when SQLite stays locked throughout creation", async () => {
  await withRepository("sqlite", async ({ repository, query, sqlite }) => {
    const writer = new Database(sqlite!.client.name);
    const record = batchRecord();
    try {
      writer.exec("BEGIN IMMEDIATE");
      await expect(repository.create(record)).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      expect(await query("SELECT id FROM run_batches WHERE id=?", [record.id])).toEqual([]);
      expect(
        await query("SELECT run_id FROM queue_jobs WHERE message_id=?", [
          record.dispatchJob!.messageId,
        ]),
      ).toEqual([]);
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

async function withRepository(
  dialect: "sqlite" | "postgresql",
  test: (harness: {
    repository: SqliteRunBatchRepository | PostgresRunBatchRepository;
    query: (statement: string, parameters: string[]) => Promise<unknown[]>;
    sqlite: ReturnType<typeof createSqliteDatabase> | undefined;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-batch-acceptance-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: join(directory, "platform.sqlite"),
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
          busyTimeoutMs: 1,
        })
      : undefined;
  const postgres = sqlite
    ? undefined
    : createPostgresDatabase({
        connectionString: postgresUrl!,
        migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      });
  try {
    await postgres?.ready;
    await test({
      repository: sqlite
        ? new SqliteRunBatchRepository(sqlite)
        : new PostgresRunBatchRepository(postgres!),
      sqlite,
      query: async (statement, parameters) => {
        if (sqlite) return sqlite.client.prepare(statement).all(...parameters);
        let index = 0;
        return (
          await postgres!.pool.query(
            statement.replace(/\?/g, () => `$${++index}`),
            parameters,
          )
        ).rows;
      },
    });
  } finally {
    if (postgres) {
      await postgres.pool.query("DELETE FROM audit_events WHERE actor_id='batch-acceptance-test'");
      await postgres.pool.query(
        "DELETE FROM transactional_outbox WHERE run_id IN (SELECT id FROM run_batches WHERE suite_id='batch-acceptance-test')",
      );
      await postgres.pool.query("DELETE FROM run_batches WHERE suite_id='batch-acceptance-test'");
      await postgres.close();
    }
    sqlite?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function batchRecord(): CreateRunBatchRecord {
  const id = randomUUID();
  return {
    id,
    projectId: DEFAULT_PROJECT_ID,
    suiteId: "batch-acceptance-test",
    suiteName: "Acceptance",
    suiteVersion: 1,
    requestedBy: { username: "launcher", source: "local" },
    creationAudit: {
      id: randomUUID(),
      actorType: "user",
      actorId: "batch-acceptance-test",
      action: "run_batch.create",
      resourceType: "run_batch",
      resourceId: id,
      projectId: DEFAULT_PROJECT_ID,
      result: "succeeded",
      requestId: randomUUID(),
      details: { totalRuns: 1 },
      recordedAt: now,
    },
    retryLimit: 0,
    environmentVariables: [],
    runnerIds: [],
    runs: [
      {
        id: randomUUID(),
        caseDefinitionId: randomUUID(),
        caseVersion: 1,
        displayName: "Wallet",
        className: "example.WalletTest",
      },
    ],
    dispatchJob: {
      schemaVersion: 1,
      messageId: randomUUID(),
      runId: id,
      attempt: 1,
      createdAt: now,
      priority: 0,
      deduplicationKey: `dispatch-batch:${id}:1`,
      kind: "dispatch-run",
      payload: { batchId: id },
    },
    createdAt: now,
  };
}
