import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteIdentityAccessRepository } from "../src/sqlite-identity-access";
import { PostgresIdentityAccessRepository } from "../src/postgres-identity-access";

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} project renaming`,
    () => {
      it("renames the persisted default project without changing its identity or re-seeding its name", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "autoforge-project-rename-"));
        const sqlite =
          dialect === "sqlite"
            ? createSqliteDatabase({
                databasePath: resolve(directory, "platform.db"),
                migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
              })
            : undefined;
        const postgres =
          dialect === "postgresql"
            ? createPostgresDatabase({
                connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
                migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
              })
            : undefined;
        const repository = sqlite
          ? new SqliteIdentityAccessRepository(sqlite)
          : new PostgresIdentityAccessRepository(postgres!);
        if (postgres) await postgres.ready;
        const before = (await repository.listProjects()).find((p) => p.id === DEFAULT_PROJECT_ID)!;
        const createdId = randomUUID();
        try {
          const renamed = await repository.renameProject({
            projectId: DEFAULT_PROJECT_ID,
            name: "中文默认项目已改名",
            updatedAt: "2026-10-28T00:00:00.000Z",
          });
          expect(renamed).toEqual({
            ...before,
            name: "中文默认项目已改名",
            updatedAt: "2026-10-28T00:00:00.000Z",
          });
          expect((await repository.listProjects()).filter((p) => p.isDefault)).toEqual([renamed]);
          await repository.createProject({
            id: createdId,
            name: "Regular project",
            slug: `rename-${createdId}`,
            createdAt: "2026-10-28T00:00:00.000Z",
          });
          await expect(
            repository.renameProject({
              projectId: createdId,
              name: "Renamed regular project",
              updatedAt: "2026-10-28T00:01:00.000Z",
            }),
          ).resolves.toMatchObject({
            id: createdId,
            name: "Renamed regular project",
            isDefault: false,
          });
          await repository.archiveProject(createdId, "2026-10-28T00:02:00.000Z");
          await expect(
            repository.renameProject({
              projectId: createdId,
              name: "Forbidden",
              updatedAt: "2026-10-28T00:03:00.000Z",
            }),
          ).rejects.toMatchObject({ code: "PROJECT_NOT_RENAMABLE" });
          await expect(
            repository.renameProject({
              projectId: "missing",
              name: "Missing",
              updatedAt: "2026-10-28T00:03:00.000Z",
            }),
          ).rejects.toMatchObject({ code: "PROJECT_NOT_RENAMABLE" });
        } finally {
          await repository.renameProject({
            projectId: DEFAULT_PROJECT_ID,
            name: before.name,
            updatedAt: before.updatedAt,
          });
          sqlite?.close();
          if (postgres) {
            await postgres.pool.query("DELETE FROM projects WHERE id = $1", [createdId]);
            await postgres.close();
          }
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  );
