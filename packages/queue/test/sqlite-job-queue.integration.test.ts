import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createSqliteDatabase, type SqliteDatabaseHandle } from "@autoforge/db";
import type { JobEnvelope } from "@autoforge/contracts";
import { afterEach, describe, expect, it } from "vitest";

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
