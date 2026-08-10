import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteExecutionEnvironmentRepository } from "../src/sqlite-execution-environment";
import { SqliteExecutionSecretRepository } from "../src/sqlite-execution-secret";

const temporaryDirectories: string[] = [];
const projectId = "00000000-0000-7000-8000-000000000001";
const actorId = "environment-actor";
const recordedAt = "2026-08-10T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite execution environment repository", () => {
  it("keeps immutable versions and enforces project scope and optimistic writes", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-environment-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    seedActor(handle);
    const environments = new SqliteExecutionEnvironmentRepository(handle);
    const secrets = new SqliteExecutionSecretRepository(handle);
    try {
      const secret = await secrets.create({
        id: "secret-1",
        versionId: "secret-version-1",
        projectId,
        name: "API token",
        normalizedName: "api token",
        description: "Staging API credential",
        valueEncrypted: "ciphertext-v1",
        actorId,
        recordedAt,
      });
      expect(secret).toMatchObject({ currentVersion: 1, revision: 1 });
      expect(JSON.stringify(secret)).not.toContain("ciphertext-v1");
      const created = await environments.create({
        id: "environment-1",
        versionId: "environment-version-1",
        projectId,
        name: "Staging",
        normalizedName: "staging",
        description: "Shared staging configuration",
        variables: [{ name: "BASE_URL", value: "https://staging.example.test" }],
        secretBindings: [{ name: "API_TOKEN", secretId: "secret-1" }],
        actorId,
        recordedAt,
      });
      expect(created).toMatchObject({
        status: "active",
        currentVersion: 1,
        revision: 1,
        current: {
          id: "environment-version-1",
          version: 1,
          secretBindings: [
            {
              name: "API_TOKEN",
              secretId: "secret-1",
              secretVersionId: "secret-version-1",
            },
          ],
        },
      });
      await expect(environments.list(["another-project"])).resolves.toEqual([]);
      await expect(environments.get("environment-1", ["another-project"])).resolves.toBeNull();

      await expect(
        secrets.rotate({
          secretId: "secret-1",
          versionId: "secret-version-2",
          expectedRevision: 1,
          valueEncrypted: "ciphertext-v2",
          actorId,
          recordedAt: "2026-08-10T00:00:30.000Z",
        }),
      ).resolves.toMatchObject({ currentVersion: 2, revision: 2 });
      const updated = await environments.update({
        environmentId: "environment-1",
        expectedRevision: 1,
        actorId,
        recordedAt: "2026-08-10T00:01:00.000Z",
        description: "Updated description",
        nextVersion: {
          id: "environment-version-2",
          variables: [{ name: "BASE_URL", value: "https://new-staging.example.test" }],
        },
      });
      expect(updated).toMatchObject({
        currentVersion: 2,
        revision: 2,
        current: {
          id: "environment-version-2",
          variables: [{ value: "https://new-staging.example.test" }],
          secretBindings: [{ secretVersionId: "secret-version-1" }],
        },
      });
      await expect(
        environments.create({
          id: "environment-copy",
          versionId: "environment-copy-version-1",
          projectId,
          name: "Staging copy",
          normalizedName: "staging copy",
          description: "Copied configuration",
          variables: updated.current.variables,
          secretBindings: updated.current.secretBindings,
          actorId,
          recordedAt: "2026-08-10T00:01:30.000Z",
        }),
      ).resolves.toMatchObject({
        current: { secretBindings: [{ secretVersionId: "secret-version-1" }] },
      });
      await expect(
        environments.getVersion("environment-version-1", projectId),
      ).resolves.toMatchObject({
        version: { version: 1, variables: [{ value: "https://staging.example.test" }] },
      });
      await expect(
        environments.update({
          environmentId: "environment-1",
          expectedRevision: 1,
          actorId,
          recordedAt: "2026-08-10T00:02:00.000Z",
          description: "Stale write",
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_ENVIRONMENT_VERSION_CONFLICT" });
      const rebound = await environments.update({
        environmentId: "environment-1",
        expectedRevision: 2,
        actorId,
        recordedAt: "2026-08-10T00:02:30.000Z",
        nextVersion: {
          id: "environment-version-3",
          secretBindings: [{ name: "API_TOKEN", secretId: "secret-1" }],
        },
      });
      expect(rebound.current).toMatchObject({
        version: 3,
        secretBindings: [{ secretVersionId: "secret-version-2" }],
      });
      await expect(environments.listVersions("environment-1", [projectId])).resolves.toMatchObject([
        { version: 3 },
        { version: 2 },
        { version: 1 },
      ]);
      await expect(
        environments.listVersions("environment-1", ["another-project"]),
      ).resolves.toEqual([]);
      await expect(
        environments.setStatus({
          environmentId: "environment-1",
          expectedRevision: 3,
          status: "disabled",
          recordedAt: "2026-08-10T00:03:00.000Z",
        }),
      ).resolves.toMatchObject({ status: "disabled", revision: 4, currentVersion: 3 });
      await secrets.setStatus({
        secretId: "secret-1",
        expectedRevision: 2,
        status: "disabled",
        recordedAt: "2026-08-10T00:03:30.000Z",
      });
      await expect(
        environments.assertSecretsAvailableForExecution(projectId, rebound.current.secretBindings),
      ).rejects.toMatchObject({ code: "EXECUTION_SECRET_UNAVAILABLE" });
      await expect(
        environments.update({
          environmentId: "environment-1",
          expectedRevision: 4,
          actorId,
          recordedAt: "2026-08-10T00:04:00.000Z",
          nextVersion: {
            id: "environment-version-4",
            secretBindings: [{ name: "API_TOKEN", secretId: "secret-1" }],
          },
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_SECRET_DISABLED" });
    } finally {
      handle.close();
    }
  });
});

function seedActor(handle: ReturnType<typeof createSqliteDatabase>): void {
  handle.client
    .prepare(
      `INSERT INTO users
       (id, username, normalized_username, display_name, source, status,
        force_password_change, failed_login_attempts, created_at, updated_at, version)
       VALUES (?, 'environment-actor', 'environment-actor', 'Environment Actor', 'local', 'active',
               0, 0, ?, ?, 1)`,
    )
    .run(actorId, recordedAt, recordedAt);
}
