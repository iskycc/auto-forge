import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteRunnerInstallationProfileRepository } from "../src/sqlite-runner-installation-profile";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite Runner installation profiles", () => {
  it("persists an encrypted profile and binds a pending install after registration", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-runner-profile-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.db"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    try {
      const repository = new SqliteRunnerInstallationProfileRepository(handle);
      await repository.upsert({
        id: "profile-1",
        runnerName: "runner-a",
        connectionEncrypted: "v1.encrypted.payload.tag",
        expectedHostKeySha256: `SHA256:${"A".repeat(43)}`,
        installationMode: "ubuntu",
        runAsRoot: false,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      });
      handle.client
        .prepare(
          `INSERT INTO runners
           (id, credential_hash, credential_version, name, disabled, draining, os, architecture,
            agent_version, protocol_version, labels_json, capabilities_json, max_concurrency,
            busy_slots, last_seen_at, terminal_enabled, created_at, updated_at)
           VALUES (?, ?, 1, ?, 0, 0, 'linux', 'amd64', '0.9.0', 1, '[]', '[]', 1, 0, ?, 0, ?, ?)`,
        )
        .run(
          "runner-1",
          "credential-profile-test",
          "runner-a",
          "2026-08-20T00:01:00.000Z",
          "2026-08-20T00:01:00.000Z",
          "2026-08-20T00:01:00.000Z",
        );

      await repository.bindPending({
        runnerName: "runner-a",
        runnerId: "runner-1",
        updatedAt: "2026-08-20T00:01:00.000Z",
      });

      await expect(repository.findByRunnerId("runner-1")).resolves.toMatchObject({
        id: "profile-1",
        runnerId: "runner-1",
        connectionEncrypted: "v1.encrypted.payload.tag",
      });
    } finally {
      handle.close();
    }
  });
});
