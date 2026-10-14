import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { RunBatchSchedulingService } from "@autoforge/application";
import type { CaseSuiteRepository, RunnerRepository } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";

const recordedAt = "2026-10-14T00:00:00.000Z";

it("keeps two saturated running batches read-only during another writer's transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-scheduling-writer-"));
  const databasePath = join(directory, "platform.sqlite");
  const handle = createSqliteDatabase({
    databasePath,
    migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    busyTimeoutMs: 1,
  });
  const writer = new Database(databasePath);
  try {
    for (const batchId of ["batch-a", "batch-b"]) {
      handle.client
        .prepare(
          `INSERT INTO run_batches
         (id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,policy_json,created_at,updated_at)
         VALUES (?,?,?,1,'running',0,2,'[]',?,?,?)`,
        )
        .run(
          batchId,
          `suite-${batchId}`,
          batchId,
          JSON.stringify({ concurrency: 1 }),
          recordedAt,
          recordedAt,
        );
      handle.client
        .prepare(
          `INSERT INTO run_batch_round_concurrencies
         (batch_id,execution_round,concurrency,source,recorded_at) VALUES (?,1,1,'base',?)`,
        )
        .run(batchId, recordedAt);
      for (const status of ["running", "queued"]) {
        const runId = `${batchId}-${status}`;
        handle.client
          .prepare(
            `INSERT INTO execution_runs
           (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at)
           VALUES (?,?,?,1,?,?,?,0,?,?)`,
          )
          .run(runId, batchId, runId, runId, `example.${runId}`, status, recordedAt, recordedAt);
      }
    }
    const scheduling = new RunBatchSchedulingService(
      new SqliteRunBatchRepository(handle),
      {} as CaseSuiteRepository,
      {} as RunnerRepository,
      { now: () => new Date(recordedAt) },
      { next: randomUUID },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
    );
    writer.exec("BEGIN IMMEDIATE");
    const scheduled = await Promise.allSettled([
      scheduling.schedule("batch-a"),
      scheduling.schedule("batch-b"),
    ]);
    expect(scheduled).toEqual([
      {
        status: "fulfilled",
        value: expect.objectContaining({ id: "batch-a", assignedRuns: 1, queuedRuns: 1 }),
      },
      {
        status: "fulfilled",
        value: expect.objectContaining({ id: "batch-b", assignedRuns: 1, queuedRuns: 1 }),
      },
    ]);
    expect(writer.inTransaction).toBe(true);
    expect(handle.client.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toEqual({
      count: 0,
    });
    expect(handle.client.prepare("SELECT COUNT(*) AS count FROM scheduling_events").get()).toEqual({
      count: 0,
    });
  } finally {
    if (writer.inTransaction) writer.exec("ROLLBACK");
    writer.close();
    handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});
