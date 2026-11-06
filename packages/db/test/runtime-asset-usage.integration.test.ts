import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeAssetUsage } from "@autoforge/contracts";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} runtime asset usage`,
    () => {
      it.each(["jdk", "jar-bundle"] as const)(
        "pages %s bindings across projects and versions, including archived references",
        async (kind) => {
          const directory = await mkdtemp(resolve(tmpdir(), "runtime-asset-usage-"));
          const sqlite =
            dialect === "sqlite"
              ? createSqliteDatabase({
                  databasePath: resolve(directory, "db.sqlite"),
                  migrationsFolder: resolve("packages/db/drizzle/sqlite"),
                })
              : undefined;
          const postgres =
            dialect === "postgres"
              ? createPostgresDatabase({
                  connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
                  migrationsFolder: resolve("packages/db/drizzle/postgresql"),
                })
              : undefined;
          await postgres?.ready;
          const repository = sqlite
            ? new SqliteProjectStructureRepository(sqlite)
            : new PostgresProjectStructureRepository(postgres!);
          const execute = async (sql: string, values: Array<string | number> = []) => {
            if (sqlite) sqlite.client.prepare(sql).run(...values);
            else {
              let position = 0;
              await postgres!.pool.query(
                sql.replaceAll("?", () => `$${++position}`),
                values,
              );
            }
          };
          const projects = [randomUUID(), randomUUID()];
          const assetId = randomUUID();
          const now = "2026-11-06T01:02:03.000Z";
          try {
            for (const [index, id] of projects.entries())
              await execute(
                "INSERT INTO projects(id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)",
                [id, `共享资源项目 ${index}`, id, now, now],
              );
            await repository.createRuntimeAsset({
              id: assetId,
              projectId: projects[0]!,
              kind,
              sourceType: "url",
              fileName: "shared-jdk.zip",
              url: "http://runtime.invalid/jdk.zip",
              sha256: "a".repeat(64),
              sizeBytes: 128,
              archiveFormat: "zip",
              createdAt: now,
            });
            const versionIds: string[] = [];
            for (let index = 0; index < 23; index++) {
              const id = randomUUID();
              const projectId = projects[index % 2]!;
              versionIds.push(id);
              await repository.createVersion({
                id,
                projectId,
                name: `版本 ${index}`,
                normalizedName: `版本 ${index}`,
                recordedAt: now,
              });
              await execute(
                `INSERT INTO project_version_runtime_assets(project_version_id,project_id,${kind === "jdk" ? "jdk_asset_id" : "jar_bundle_asset_id"},revision,updated_at) VALUES (?,?,?,1,?)`,
                [id, projectId, assetId, now],
              );
            }
            await execute("UPDATE project_versions SET status='archived' WHERE id=?", [
              versionIds[0]!,
            ]);
            await execute("UPDATE projects SET archived=TRUE WHERE id=?", [projects[1]!]);

            const references: RuntimeAssetUsage[] = [];
            let cursor: string | undefined;
            do {
              const page = await repository.listRuntimeAssetUsagesPage({
                runtimeAssetId: assetId,
                limit: 7,
                ...(cursor ? { cursor } : {}),
              });
              expect(page.items.length).toBeLessThanOrEqual(7);
              references.push(...page.items);
              cursor = page.nextCursor;
            } while (cursor);
            expect(references).toHaveLength(23);
            expect(new Set(references.map((item) => item.referenceId)).size).toBe(23);
            expect(new Set(references.map((item) => item.projectId))).toEqual(new Set(projects));
            expect(
              references.find((item) => item.projectVersionId === versionIds[0]),
            ).toMatchObject({
              projectVersionName: "版本 0",
              versionStatus: "archived",
            });
            expect(references.some((item) => item.projectArchived)).toBe(true);
            expect(references.filter((item) => !item.projectVersionId)).toHaveLength(0);
            expect(
              (
                await repository.listRuntimeAssetUsagesPage({
                  runtimeAssetId: randomUUID(),
                  limit: 20,
                })
              ).items,
            ).toEqual([]);
            await execute("DELETE FROM project_version_runtime_assets WHERE project_version_id=?", [
              versionIds[0]!,
            ]);
            expect(
              (await repository.listRuntimeAssetUsagesPage({ runtimeAssetId: assetId, limit: 100 }))
                .items,
            ).toHaveLength(22);
            await expect(
              repository.listRuntimeAssetUsagesPage({ runtimeAssetId: assetId, limit: 101 }),
            ).rejects.toThrow();
          } finally {
            for (const id of projects.reverse())
              await execute("DELETE FROM projects WHERE id=?", [id]);
            sqlite?.close();
            await postgres?.close();
            await rm(directory, { recursive: true, force: true });
          }
        },
      );
    },
  );
}
