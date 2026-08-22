import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite project version structure", () => {
  it("persists versions, ordered stages and project runtime assets", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-project-structure-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.db"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    const repository = new SqliteProjectStructureRepository(handle);
    const now = "2026-08-14T00:00:00.000Z";
    try {
      const version = await repository.createVersion({
        id: "version-1",
        projectId: DEFAULT_PROJECT_ID,
        name: "2.0.0",
        normalizedName: "2.0.0",
        recordedAt: now,
      });
      const stage = await repository.createStage({
        id: "stage-1",
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId: version.id,
        name: "系统测试",
        normalizedName: "系统测试",
        description: "内网环境",
        recordedAt: now,
      });
      const jdk = await repository.createRuntimeAsset({
        id: "jdk-1",
        projectId: DEFAULT_PROJECT_ID,
        kind: "jdk",
        sourceType: "url",
        fileName: "jdk.tar.gz",
        url: "http://10.0.0.8/jdk.tar.gz",
        sha256: "a".repeat(64),
        sizeBytes: 1024,
        archiveFormat: "tar.gz",
        createdAt: now,
      });
      const configuration = await repository.updateAdapterConfiguration({
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId: version.id,
        jdkAssetId: jdk.id,
        expectedRevision: 0,
        updatedAt: now,
      });
      await repository.replaceVersionRuntimeAsset(version.id, {
        id: "bundle-1",
        projectId: DEFAULT_PROJECT_ID,
        kind: "jar-bundle",
        sourceType: "url",
        fileName: "dependencies-1.zip",
        url: "http://10.0.0.8/dependencies-1.zip",
        sha256: "b".repeat(64),
        sizeBytes: 2_048,
        archiveFormat: "zip",
        createdBy: "jenkins",
        createdAt: now,
      });
      await repository.replaceVersionRuntimeAsset(version.id, {
        id: "bundle-2",
        projectId: DEFAULT_PROJECT_ID,
        kind: "jar-bundle",
        sourceType: "url",
        fileName: "dependencies-2.zip",
        url: "http://10.0.0.8/dependencies-2.zip",
        sha256: "c".repeat(64),
        sizeBytes: 4_096,
        archiveFormat: "zip",
        createdBy: "jenkins",
        createdAt: "2026-08-14T00:01:00.000Z",
      });

      expect(stage.position).toBe(1);
      expect(configuration).toMatchObject({
        revision: 1,
        jdkAsset: { id: jdk.id, sourceType: "url" },
      });
      await expect(repository.list(DEFAULT_PROJECT_ID)).resolves.toMatchObject({
        versions: [
          {
            id: version.id,
            stages: [{ id: stage.id }],
            adapterConfiguration: {
              jdkAsset: { id: jdk.id },
              jarBundleAsset: { id: "bundle-2" },
            },
          },
        ],
        adapterConfiguration: { revision: 0 },
      });
      await expect(
        repository.getAdapterConfiguration(DEFAULT_PROJECT_ID, version.id),
      ).resolves.toMatchObject({
        projectVersionId: version.id,
        jdkAsset: { id: jdk.id },
        jarBundleAsset: { id: "bundle-2", fileName: "dependencies-2.zip" },
        revision: 3,
      });
      expect(
        handle.client
          .prepare("SELECT COUNT(*) AS value FROM project_runtime_assets WHERE id = ?")
          .get("bundle-1"),
      ).toEqual({ value: 0 });
      await expect(
        repository.updateAdapterConfiguration({
          projectId: DEFAULT_PROJECT_ID,
          projectVersionId: version.id,
          expectedRevision: 0,
          updatedAt: now,
        }),
      ).rejects.toMatchObject({ code: "PROJECT_ADAPTER_CONFIGURATION_REVISION_CONFLICT" });

      const inheritedVersion = await repository.createVersion({
        id: "version-2",
        projectId: DEFAULT_PROJECT_ID,
        name: "2.1.0",
        normalizedName: "2.1.0",
        recordedAt: "2026-08-14T00:02:00.000Z",
      });
      await expect(
        repository.inheritAdapterConfiguration({
          projectId: DEFAULT_PROJECT_ID,
          sourceProjectVersionId: version.id,
          targetProjectVersionId: inheritedVersion.id,
          expectedRevision: 0,
          updatedAt: "2026-08-14T00:03:00.000Z",
        }),
      ).resolves.toMatchObject({
        inheritedFromProjectVersionId: version.id,
        jdkAsset: { id: jdk.id },
        jarBundleAsset: { id: "bundle-2" },
      });

      const detached = await repository.detachVersionRuntimeAsset({
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId: version.id,
        kind: "jar-bundle",
        expectedRevision: 3,
        updatedAt: "2026-08-14T00:04:00.000Z",
      });
      expect(detached).toMatchObject({ configuration: { jdkAsset: { id: jdk.id } } });
      expect(detached.orphanedAsset).toBeUndefined();
      await expect(
        repository.getAdapterConfiguration(DEFAULT_PROJECT_ID, inheritedVersion.id),
      ).resolves.toMatchObject({ jarBundleAsset: { id: "bundle-2" } });
    } finally {
      handle.close();
    }
  });
});
