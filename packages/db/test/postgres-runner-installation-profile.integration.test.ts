import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresRunnerInstallationProfileRepository } from "../src/postgres-runner-installation-profile";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)("PostgreSQL Runner installation profiles", () => {
  it("persists and binds the same encrypted profile contract as SQLite", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const profileId = randomUUID();
    const runnerId = randomUUID();
    const runnerName = `profile-runner-${runnerId}`;
    try {
      await handle.ready;
      await handle.pool.query(
        `INSERT INTO runners
         (id, credential_hash, credential_version, name, disabled, draining, os, architecture,
          agent_version, protocol_version, labels_json, capabilities_json, max_concurrency,
          busy_slots, last_seen_at, terminal_enabled, created_at, updated_at)
         VALUES ($1, $2, 1, $3, false, false, 'linux', 'amd64', '0.9.0', 1, '[]', '[]', 1, 0,
                 $4, false, $4, $4)`,
        [runnerId, randomUUID(), runnerName, "2026-08-20T00:00:00.000Z"],
      );
      const repository = new PostgresRunnerInstallationProfileRepository(handle);
      await repository.upsert({
        id: profileId,
        runnerName,
        connectionEncrypted: "v1.encrypted.payload.tag",
        expectedHostKeySha256: `SHA256:${"A".repeat(43)}`,
        installationMode: "ubuntu",
        runAsRoot: false,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      });
      await repository.bindPending({
        runnerName,
        runnerId,
        updatedAt: "2026-08-20T00:01:00.000Z",
      });

      await expect(repository.findByRunnerId(runnerId)).resolves.toMatchObject({
        id: profileId,
        runnerId,
        connectionEncrypted: "v1.encrypted.payload.tag",
      });
    } finally {
      await handle.pool.query("DELETE FROM runner_installation_profiles WHERE id = $1", [
        profileId,
      ]);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      await handle.close();
    }
  });
});
