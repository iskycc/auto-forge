import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RunBatchSchedulingService } from "@autoforge/application";
import type { CaseSuiteRepository, RunnerRepository } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const timestamp = "2026-10-10T00:00:00.000Z";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !postgresUrl)(
    `${dialect} manual execution context`,
    () => {
      it.each([
        { kind: "standard", suiteId: "single:case", manual: true },
        { kind: "case_log_rerun", suiteId: "suite", manual: true },
        { kind: "standard", suiteId: "suite", manual: false },
        { kind: "final_failure_rerun", suiteId: "single:case", manual: false },
      ])(
        "checks persisted $kind / $suiteId without loading batch members",
        async ({ kind, suiteId, manual }) => {
          const directory = await mkdtemp(join(tmpdir(), "autoforge-manual-context-"));
          const sqlite =
            dialect === "sqlite"
              ? createSqliteDatabase({
                  databasePath: join(directory, "test.sqlite"),
                  migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
                })
              : undefined;
          const postgres =
            dialect === "postgres"
              ? createPostgresDatabase({
                  connectionString: postgresUrl!,
                  migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
                  poolMax: 1,
                })
              : undefined;
          const batchId = randomUUID();
          const runId = randomUUID();
          const attemptId = randomUUID();
          const runnerId = randomUUID();
          const execute = async (sql: string, parameters: string[]) => {
            if (sqlite) sqlite.client.prepare(sql).run(...parameters);
            else {
              let index = 0;
              await postgres!.pool.query(
                sql.replace(/\?/gu, () => `$${++index}`),
                parameters,
              );
            }
          };
          try {
            if (postgres) await postgres.ready;
            await execute(
              `INSERT INTO runners (id, credential_hash, name, os, architecture, agent_version, protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots, last_seen_at, created_at, updated_at) VALUES (?,?,'manual fixture','linux','amd64','0.4.0',1,'{}','[]',1,0,?,?,?)`,
              [runnerId, runnerId, timestamp, timestamp, timestamp],
            );
            await execute(
              `INSERT INTO run_batches (id, suite_id, suite_name, suite_version, batch_kind, status, retry_limit, total_runs, environment_json, created_at, updated_at) VALUES (?,?,'manual fixture',1,?,'running',0,1,'[]',?,?)`,
              [batchId, suiteId, kind, timestamp, timestamp],
            );
            await execute(
              `INSERT INTO execution_runs (id, batch_id, case_definition_id, case_version, display_name, class_name, status, attempt_count, created_at, updated_at) VALUES (?,?,?,1,'manual fixture','fixture.Manual','running',1,?,?)`,
              [runId, batchId, runId, timestamp, timestamp],
            );
            await execute(
              `INSERT INTO run_attempts (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at) VALUES (?,?,?,1,'running',1,?)`,
              [attemptId, runId, runnerId, timestamp],
            );
            const repository = sqlite
              ? new SqliteRunBatchRepository(sqlite)
              : new PostgresRunBatchRepository(postgres!);
            const service = new RunBatchSchedulingService(
              repository,
              {} as CaseSuiteRepository,
              {} as RunnerRepository,
              { now: () => new Date(timestamp) },
              { next: () => randomUUID() },
              {
                maximumCpuUtilizationPercent: 90,
                maximumMemoryUtilizationPercent: 90,
                maximumLoadPerCpu: 2,
              },
              45,
            );
            if (manual)
              await expect(service.getManualAttemptContext(attemptId)).resolves.toMatchObject({
                batchId,
                executionRunId: runId,
                attemptId,
                status: "running",
              });
            else
              await expect(service.getManualAttemptContext(attemptId)).rejects.toMatchObject({
                code: "MANUAL_EXECUTION_REQUIRED",
              });
          } finally {
            try {
              if (postgres) {
                await execute("DELETE FROM run_batches WHERE id = ?", [batchId]);
                await execute("DELETE FROM runners WHERE id = ?", [runnerId]);
              }
            } finally {
              sqlite?.close();
              await postgres?.close();
              await rm(directory, { recursive: true, force: true });
            }
          }
        },
      );
    },
  );
}
