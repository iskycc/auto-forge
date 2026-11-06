import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ProjectStructureService, type ProjectStructureRepository } from "@autoforge/application";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase, SqliteProjectStructureRepository } from "@autoforge/db/sqlite";
import { createPostgresDatabase, PostgresProjectStructureRepository } from "@autoforge/db/postgres";
import { LocalObjectStore } from "@autoforge/object-store/local";
import { MinioObjectStore } from "@autoforge/object-store/minio";

const fullAvailable = [
  "AUTOFORGE_TEST_POSTGRES_URL",
  "AUTOFORGE_TEST_MINIO_ENDPOINT",
  "AUTOFORGE_TEST_MINIO_ACCESS_KEY",
  "AUTOFORGE_TEST_MINIO_SECRET_KEY",
].every((name) => !!process.env[name]);
const timestamp = "2026-11-06T00:00:00.000Z";

for (const mode of ["lite", "full"] as const) {
  describe.skipIf(mode === "full" && !fullAvailable)(
    `${mode} managed Jenkins dependency uploads`,
    () => {
      it("stores exact bytes, atomically replaces the version binding and rejects an archive race without losing the previous dependency", async () => {
        const fixture = await storageFixture(mode);
        const { repository, objects } = fixture;
        const service = new ProjectStructureService(
          repository,
          objects,
          { now: () => new Date(timestamp) },
          { next: randomUUID },
        );
        const upload = (contents: number[]) => {
          const bytes = new Uint8Array(contents);
          return {
            projectId: DEFAULT_PROJECT_ID,
            version: "钱包回归",
            fileName: "构建依赖.zip",
            archiveFormat: "zip" as const,
            sizeBytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            content: (async function* () {
              yield bytes.subarray(0, 2);
              yield bytes.subarray(2);
            })(),
          };
        };
        try {
          const first = await service.replaceUploadedVersionDependency(
            upload([0x50, 0x4b, 3, 4, 1]),
          );
          expect(first.asset).toMatchObject({ sourceType: "upload", fileName: "构建依赖.zip" });
          expect(first.asset.url).toBeUndefined();
          expect(await objects.read(first.asset.objectKey!)).toEqual(
            Buffer.from([0x50, 0x4b, 3, 4, 1]),
          );
          const jdk = await repository.createRuntimeAsset({
            id: randomUUID(),
            projectId: DEFAULT_PROJECT_ID,
            kind: "jdk",
            sourceType: "url",
            fileName: "jdk.tar.gz",
            url: "http://runtime.invalid/jdk.tar.gz",
            archiveFormat: "tar.gz",
            sha256: "a".repeat(64),
            sizeBytes: 100,
            createdAt: timestamp,
          });
          await repository.updateAdapterConfiguration({
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: first.version.id,
            jdkAssetId: jdk.id,
            jarBundleAssetId: first.asset.id,
            expectedRevision: (
              await repository.getAdapterConfiguration(DEFAULT_PROJECT_ID, first.version.id)
            ).revision,
            updatedAt: timestamp,
          });
          const second = await service.replaceUploadedVersionDependency(
            upload([0x50, 0x4b, 3, 4, 2]),
          );
          expect(second.version.id).toBe(first.version.id);
          expect(
            await repository.getAdapterConfiguration(DEFAULT_PROJECT_ID, second.version.id),
          ).toMatchObject({
            jdkAsset: { id: jdk.id },
            jarBundleAsset: { id: second.asset.id },
          });
          expect(await objects.read(second.asset.objectKey!)).toEqual(
            Buffer.from([0x50, 0x4b, 3, 4, 2]),
          );
          // Retain uploaded files for existing execution snapshots and managed-library cleanup.
          expect(await objects.read(first.asset.objectKey!)).toEqual(
            Buffer.from([0x50, 0x4b, 3, 4, 1]),
          );
          const racingAssetId = randomUUID();
          const racingRepository = new Proxy(repository, {
            get(target, property, receiver) {
              if (property !== "replaceVersionRuntimeAsset")
                return Reflect.get(target, property, receiver);
              return async (
                ...args: Parameters<ProjectStructureRepository["replaceVersionRuntimeAsset"]>
              ) => {
                await fixture.archiveVersion(first.version.id);
                return target.replaceVersionRuntimeAsset(...args);
              };
            },
          });
          const racingService = new ProjectStructureService(
            racingRepository,
            objects,
            { now: () => new Date(timestamp) },
            { next: () => racingAssetId },
          );
          await expect(
            racingService.replaceUploadedVersionDependency(upload([0x50, 0x4b, 3, 4, 3])),
          ).rejects.toMatchObject({ code: "PROJECT_VERSION_ARCHIVED" });
          expect(
            await objects.exists(
              `projects/${DEFAULT_PROJECT_ID}/runtime-assets/${racingAssetId}.zip`,
            ),
          ).toBe(false);
          expect(
            await repository.getAdapterConfiguration(DEFAULT_PROJECT_ID, first.version.id),
          ).toMatchObject({
            jdkAsset: { id: jdk.id },
            jarBundleAsset: { id: second.asset.id },
          });
          expect(
            (await repository.listRuntimeAssetsPage({ sourceType: "upload", limit: 20 })).items
              .map((item) => item.id)
              .sort(),
          ).toEqual([first.asset.id, second.asset.id].sort());
          await expect(
            service.replaceUploadedVersionDependency(upload([0x50, 0x4b, 3, 4, 4])),
          ).rejects.toMatchObject({ code: "PROJECT_VERSION_ARCHIVED" });
        } finally {
          await fixture.close();
        }
      });
    },
  );
}

async function storageFixture(mode: "lite" | "full") {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-jenkins-upload-"));
  if (mode === "lite") {
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "platform.db"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    return {
      repository: new SqliteProjectStructureRepository(handle),
      objects: new LocalObjectStore(directory),
      archiveVersion: async (id: string) => {
        handle.client
          .prepare("UPDATE project_versions SET status = 'archived' WHERE id = ?")
          .run(id);
      },
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const suffix = randomUUID().replaceAll("-", "");
  const name = `jenkins_upload_${suffix}`;
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    poolMax: 2,
    migrationsFolder: resolve("packages/db/drizzle/postgresql"),
  });
  await handle.ready;
  const endpoint = new URL(process.env.AUTOFORGE_TEST_MINIO_ENDPOINT!);
  const options = {
    endPoint: endpoint.hostname,
    port: Number(endpoint.port),
    useSSL: false,
    accessKey: process.env.AUTOFORGE_TEST_MINIO_ACCESS_KEY!,
    secretKey: process.env.AUTOFORGE_TEST_MINIO_SECRET_KEY!,
    bucket: `jenkins-${suffix}`,
    region: "us-east-1",
  };
  const { Client } = createRequire(resolve("packages/object-store/package.json"))("minio") as {
    Client: new (configuration: typeof options) => {
      makeBucket(bucket: string, region: string): Promise<void>;
      listObjectsV2(
        bucket: string,
        prefix: string,
        recursive: boolean,
      ): AsyncIterable<{ name?: string }>;
      removeObject(bucket: string, name: string): Promise<void>;
      removeBucket(bucket: string): Promise<void>;
    };
  };
  const client = new Client(options);
  await client.makeBucket(options.bucket, options.region);
  return {
    repository: new PostgresProjectStructureRepository(handle),
    objects: new MinioObjectStore(options),
    archiveVersion: async (id: string) => {
      await handle.pool.query("UPDATE project_versions SET status = 'archived' WHERE id = $1", [
        id,
      ]);
    },
    close: async () => {
      for await (const entry of client.listObjectsV2(options.bucket, "", true))
        if (entry.name) await client.removeObject(options.bucket, entry.name);
      await client.removeBucket(options.bucket);
      await handle.close();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
