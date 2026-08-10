import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createSqliteDatabase, type SqliteDatabaseHandle } from "@autoforge/db";

import { SqliteJobQueue } from "../src/sqlite-job-queue";
import { jobQueueContract, type JobQueueHarness } from "./job-queue.contract";

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
