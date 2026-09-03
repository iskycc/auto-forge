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
      const uploadedJdk = await repository.createRuntimeAsset({
        id: "jdk-uploaded",
        projectId: DEFAULT_PROJECT_ID,
        kind: "jdk",
        sourceType: "upload",
        fileName: "uploaded-jdk.zip",
        objectKey: "projects/default/runtime-assets/jdk-uploaded.zip",
        sha256: "d".repeat(64),
        sizeBytes: 8192,
        archiveFormat: "zip",
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
        repository.listRuntimeAssetsPage({ sourceType: "url", limit: 1 }),
      ).resolves.toMatchObject({ items: [{ id: "bundle-2" }], nextCursor: "bundle-2" });
      await expect(
        repository.listRuntimeAssetsPage({
          sourceType: "url",
          afterId: "bundle-2",
          limit: 10,
        }),
      ).resolves.toMatchObject({ items: [{ id: "jdk-1" }] });
      await expect(
        repository.findRuntimeAssetsByObjectKeys([uploadedJdk.objectKey!]),
      ).resolves.toMatchObject([{ id: uploadedJdk.id, kind: "jdk", sourceType: "upload" }]);
      handle.client
        .prepare(
          `INSERT INTO run_batches
           (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
            total_runs, adapter_runtime_json, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'queued', 0, '[]', 1, ?, ?, ?)`,
        )
        .run(
          "batch-runtime-asset-delete-guard",
          "suite-runtime-asset-delete-guard",
          "Runtime asset deletion guard",
          JSON.stringify({ jdk: { id: uploadedJdk.id } }),
          now,
          now,
        );
      await expect(repository.deleteRuntimeAssetIfUnreferenced(uploadedJdk.id)).resolves.toEqual({
        status: "referenced",
      });
      handle.client
        .prepare("UPDATE run_batches SET status = 'succeeded' WHERE id = ?")
        .run("batch-runtime-asset-delete-guard");
      await expect(repository.deleteRuntimeAssetIfUnreferenced(uploadedJdk.id)).resolves.toEqual({
        status: "deleted",
        asset: uploadedJdk,
      });
      await expect(
        repository.findRuntimeAssetsByObjectKeys([uploadedJdk.objectKey!]),
      ).resolves.toEqual([]);
      await expect(repository.deleteRuntimeAssetIfUnreferenced(uploadedJdk.id)).resolves.toEqual({
        status: "not_found",
      });
      handle.client
        .prepare("DELETE FROM run_batches WHERE id = ?")
        .run("batch-runtime-asset-delete-guard");
      await expect(
        repository.updateAdapterConfiguration({
          projectId: DEFAULT_PROJECT_ID,
          projectVersionId: version.id,
          expectedRevision: 0,
          updatedAt: now,
        }),
      ).rejects.toMatchObject({ code: "PROJECT_ADAPTER_CONFIGURATION_REVISION_CONFLICT" });
      await expect(repository.deleteRuntimeAssetIfUnreferenced(jdk.id)).resolves.toEqual({
        status: "referenced",
      });

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

  it("retries Jenkins dependency replacement after lock contention", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-project-contention-"));
    temporaryDirectories.push(directory);
    const databasePath = resolve(directory, "autoforge.db");
    const handle = createSqliteDatabase({
      databasePath,
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    const lockHandle = createSqliteDatabase({
      databasePath,
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    const repository = new SqliteProjectStructureRepository(handle);
    handle.client.pragma("busy_timeout = 1");
    const now = "2026-08-26T00:00:00.000Z";
    try {
      const version = await repository.createVersion({
        id: "version-contention",
        projectId: DEFAULT_PROJECT_ID,
        name: "3.0.0",
        normalizedName: "3.0.0",
        recordedAt: now,
      });
      lockHandle.client.exec("BEGIN IMMEDIATE");
      const releaseLock = setTimeout(() => lockHandle.client.exec("COMMIT"), 20);
      try {
        await expect(
          repository.replaceVersionRuntimeAsset(version.id, {
            id: "bundle-contention",
            projectId: DEFAULT_PROJECT_ID,
            kind: "jar-bundle",
            sourceType: "url",
            fileName: "dependencies.zip",
            url: "http://jenkins.internal/dependencies.zip",
            sha256: "d".repeat(64),
            sizeBytes: 8_192,
            archiveFormat: "zip",
            createdBy: "jenkins",
            createdAt: now,
          }),
        ).resolves.toMatchObject({ asset: { id: "bundle-contention" } });
      } finally {
        clearTimeout(releaseLock);
        if (lockHandle.client.inTransaction) lockHandle.client.exec("ROLLBACK");
      }
    } finally {
      lockHandle.close();
      handle.close();
    }
  });
});
