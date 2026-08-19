import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe } from "vitest";

import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresRunnerGroupRepository } from "../src/postgres-runner-group";
import { runnerGroupContract, type RunnerGroupHarness } from "./runner-group.contract";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const CREATED_AT = "2026-08-20T00:00:00.000Z";

describe.skipIf(!connectionString)("PostgreSQL runner group", () => {
  runnerGroupContract("PostgreSQL runner group", createHarness);
});

async function createHarness(): Promise<RunnerGroupHarness> {
  const handle = createPostgresDatabase({
    connectionString: connectionString!,
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
  });
  await handle.ready;
  const runnerIds = [randomUUID(), randomUUID()] as const;
  for (const runnerId of runnerIds) {
    await handle.pool.query(
      `INSERT INTO runners
        (id, credential_hash, name, disabled, draining, os, architecture, agent_version,
         protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots,
         last_seen_at, created_at, updated_at)
       VALUES ($1, $2, $1, FALSE, FALSE, 'linux', 'amd64', '0.7.2', 1, '{}', '[]', 2, 0,
               $3, $3, $3)`,
      [runnerId, `credential-${runnerId}`, CREATED_AT],
    );
  }
  return {
    repository: new PostgresRunnerGroupRepository(handle),
    runnerIds,
    async purgeRunner(runnerId) {
      await handle.pool.query("UPDATE runners SET purged_at = $1 WHERE id = $2", [
        CREATED_AT,
        runnerId,
      ]);
    },
    async dispose() {
      await handle.pool.query("DELETE FROM runner_groups WHERE id IN ('group-1', 'group-2')");
      await handle.pool.query("DELETE FROM runners WHERE id = ANY($1::text[])", [runnerIds]);
      await handle.close();
    },
  };
}
