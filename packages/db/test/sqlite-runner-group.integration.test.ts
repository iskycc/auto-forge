import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteRunnerGroupRepository } from "../src/sqlite-runner-group";
import { runnerGroupContract, type RunnerGroupHarness } from "./runner-group.contract";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createHarness(): Promise<RunnerGroupHarness> {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-runner-groups-"));
  temporaryDirectories.push(directory);
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  const runnerIds = ["runner-a", "runner-b"] as const;
  for (const runnerId of runnerIds) {
    handle.client
      .prepare(
        `INSERT INTO runners
          (id, credential_hash, name, disabled, draining, os, architecture, agent_version,
           protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots,
           last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, 0, 0, 'linux', 'amd64', '0.7.2', 1, '{}', '[]', 2, 0, ?, ?, ?)`,
      )
      .run(runnerId, `credential-${runnerId}`, runnerId, CREATED_AT, CREATED_AT, CREATED_AT);
  }
  return {
    repository: new SqliteRunnerGroupRepository(handle),
    runnerIds,
    async purgeRunner(runnerId) {
      handle.client
        .prepare("UPDATE runners SET purged_at = ? WHERE id = ?")
        .run(CREATED_AT, runnerId);
    },
    async dispose() {
      handle.close();
    },
  };
}

const CREATED_AT = "2026-08-20T00:00:00.000Z";

runnerGroupContract("SQLite runner group", createHarness);
