import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createSqliteDatabase, type SqliteDatabaseHandle } from "@autoforge/db";
import type { JobEnvelope } from "@autoforge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteJobQueue } from "../src/sqlite-job-queue";
import { jobQueueContract, type JobQueueHarness } from "./job-queue.contract";

const contentionTestDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    contentionTestDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

jobQueueContract("SQLite job queue", async (testId): Promise<JobQueueHarness> => {
  const directory = await mkdtemp(resolve(tmpdir(), `autoforge-queue-${testId}-`));
  const databasePath = resolve(directory, "autoforge.db");
  let handle = openDatabase(databasePath);

  return {
    queue: new SqliteJobQueue(handle),
    async restart() {
      handle.close();
      handle = openDatabase(databasePath);
      return new SqliteJobQueue(handle);
    },
    async dispose() {
      handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});

function openDatabase(databasePath: string): SqliteDatabaseHandle {
  return createSqliteDatabase({
    databasePath,
    migrationsFolder: resolve(process.cwd(), "packages/db/drizzle/sqlite"),
  });
}

describe("SQLite job queue lock recovery", () => {
  it("uses a separate dispatch index behind a hundred thousand background jobs", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-queue-backlog-"));
    contentionTestDirectories.push(directory);
    const handle = openDatabase(resolve(directory, "queue.sqlite"));
    try {
      handle.client
        .exec(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<100000)
        INSERT INTO queue_jobs(message_id,run_id,attempt,schema_version,kind,payload_json,priority,deduplication_key,status,available_at,created_at,updated_at)
        SELECT 'background-'||n,'background-'||n,1,1,'jar-import','{}',100,'background-'||n,'available','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z' FROM sequence`);
      const queue = new SqliteJobQueue(handle);
      const statements = vi.spyOn(handle.client, "prepare");
      await queue.publish({
        ...contentionJob(),
        messageId: "dispatch",
        deduplicationKey: "dispatch",
        kind: "dispatch-run",
      });
      const [claimed] = await queue.claim({
        workerId: "execution",
        now: "2026-09-07T00:00:00.000Z",
        leaseExpiresAt: "2026-09-07T00:00:30.000Z",
        limit: 1,
        workClass: "execution",
      });
      expect(claimed?.job.messageId).toBe("dispatch");
      const claimSql = statements.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes("ORDER BY priority DESC"));
      statements.mockRestore();
      expect(claimSql).toBeDefined();
      const plan = handle.client
        .prepare(`EXPLAIN QUERY PLAN ${claimSql}`)
        .all("2026-09-07T00:00:00.000Z", 1) as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" ")).toContain("queue_jobs_execution_claim_idx");
      expect(plan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE");
    } finally {
      handle.close();
    }
  }, 30_000);
  it("backs off and publishes after a concurrent writer releases the database", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-queue-contention-"));
    contentionTestDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.db");
    const queueHandle = openDatabase(databasePath);
    const lockHandle = openDatabase(databasePath);
    queueHandle.client.pragma("busy_timeout = 1");
    lockHandle.client.exec("BEGIN IMMEDIATE");
    const queue = new SqliteJobQueue(queueHandle);
    const releaseLock = setTimeout(() => lockHandle.client.exec("COMMIT"), 20);

    try {
      await expect(queue.publish(contentionJob())).resolves.toBe("published");
      await expect(queue.depth()).resolves.toEqual({
        available: 1,
        leased: 0,
        deadLetter: 0,
      });
    } finally {
      clearTimeout(releaseLock);
      if (lockHandle.client.inTransaction) lockHandle.client.exec("ROLLBACK");
      lockHandle.close();
      queueHandle.close();
    }
  });
});

function contentionJob(): JobEnvelope {
  return {
    schemaVersion: 1,
    messageId: "message-contention",
    runId: "run-contention",
    attempt: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    priority: 10,
    deduplicationKey: "jar-import:contention",
    kind: "jar-import",
    payload: { jobId: "import-contention" },
  };
}
