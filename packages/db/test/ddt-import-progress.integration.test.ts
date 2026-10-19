import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ID, type DdtScope } from "@autoforge/domain";
import type { DdtImportFileSummary } from "@autoforge/contracts";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";

const now = "2026-10-19T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} import progress`,
    () => {
      it("reads only summaries, paginates every file without omissions, and enforces formal-job scope", async () => {
        const fixture = await createFixture(dialect);
        const { repository, scope, jobId } = fixture;
        try {
          const summary = await repository.listImportJobSummaries({ ...scope, limit: 1 });
          expect(summary.items).toHaveLength(1);
          expect(summary.items[0]).toMatchObject({ id: jobId, totalFiles: 1001, failedFiles: 1 });
          expect(summary.items[0]).not.toHaveProperty("files");
          expect(summary.items[0]).not.toHaveProperty("uploads");
          expect(fixture.queries()).not.toMatch(/ddt_import_files|uploads_json|SELECT \*/i);
          expect(await repository.getImportJobSummary({ ...scope, jobId })).toEqual(
            summary.items[0],
          );
          let cursor: { id: string; createdAt: string } | undefined;
          const all: DdtImportFileSummary[] = [];
          for (let page = 0; page < 21; page += 1) {
            const rows = await repository.listImportFiles({
              ...scope,
              jobId,
              limit: 50,
              ...(cursor ? { cursor } : {}),
            });
            expect(rows).toHaveLength(page === 20 ? 1 : 50);
            all.push(...rows);
            cursor = rows.at(-1);
          }
          expect(all.map((file) => file.id)).toEqual(
            [...Array.from({ length: 1000 }, (_, index) => index + 1), 0].map(
              (index) => `${jobId}-${String(index).padStart(5, "0")}`,
            ),
          );
          expect(all.find((file) => file.id === `${jobId}-01000`)).toMatchObject({
            status: "excluded",
            errorSummary: "文件格式有误",
          });
          for (const wrong of [
            { ...scope, projectId: "other" },
            { ...scope, projectVersionId: "other" },
            { ...scope, testStageId: "other" },
          ]) {
            expect(
              (await repository.listImportJobSummaries({ ...wrong, limit: 50 })).items,
            ).toEqual([]);
            expect(await repository.getImportJobSummary({ ...wrong, jobId })).toBeNull();
            expect(await repository.listImportFiles({ ...wrong, jobId, limit: 50 })).toEqual([]);
          }
          // Existing preview/worker readers retain their complete manifests.
          expect((await repository.getImportJob(jobId))?.files).toHaveLength(1001);
          expect((await repository.listImportJobs({ ...scope, limit: 50 })).items).toHaveLength(1);
        } finally {
          await fixture.close();
        }
      });
    },
  );
}

async function createFixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-import-progress-"));
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
    ? new SqliteDdtRepository(sqlite)
    : new PostgresDdtRepository(postgres!);
  const structures = sqlite
    ? new SqliteProjectStructureRepository(sqlite)
    : new PostgresProjectStructureRepository(postgres!);
  const scope: DdtScope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: randomUUID(),
    testStageId: randomUUID(),
  };
  await structures.createVersion({
    id: scope.projectVersionId,
    projectId: scope.projectId,
    name: scope.projectVersionId,
    normalizedName: scope.projectVersionId,
    recordedAt: now,
  });
  await structures.createStage({
    ...scope,
    id: scope.testStageId,
    name: "test",
    normalizedName: "test",
    description: "",
    recordedAt: now,
  });
  const jobId = randomUUID();
  for (const debugOwnerId of [undefined, "personal-user"]) {
    const id = debugOwnerId ? `${jobId}-debug` : jobId;
    await repository.createImportPreview({
      job: {
        ...scope,
        id,
        status: "previewed",
        uploads: [],
        progressPercent: 0,
        totalFiles: 1001,
        validFiles: 1000,
        totalRows: 1000,
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        skippedCount: 0,
        failedFiles: 1,
        createdAt: now,
        updatedAt: now,
        ...(debugOwnerId ? { debugOwnerId } : {}),
      },
      files: Array.from({ length: debugOwnerId ? 1 : 1001 }, (_, index) => ({
        id: `${id}-${String(index).padStart(5, "0")}`,
        uploadId: "upload",
        fileName: "batch.zip",
        archiveEntryName: `文件-${index}.csv`,
        rowCount: 1,
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        ...(index === 1000 ? { errorSummary: "文件格式有误" } : {}),
      })),
    });
  }
  // Cross a timestamp boundary where the next ID is lower than the previous page.
  const later = "2026-10-19T00:00:01.000Z";
  if (sqlite)
    sqlite.client
      .prepare("UPDATE ddt_import_files SET created_at = ? WHERE id = ?")
      .run(later, `${jobId}-00000`);
  else
    await postgres!.pool.query("UPDATE ddt_import_files SET created_at = $1 WHERE id = $2", [
      later,
      `${jobId}-00000`,
    ]);
  // Personal debug manifests must not leak through the formal import API.
  expect(await repository.getImportJobSummary({ ...scope, jobId: `${jobId}-debug` })).toBeNull();
  expect(
    await repository.listImportFiles({ ...scope, jobId: `${jobId}-debug`, limit: 50 }),
  ).toEqual([]);
  const sqliteQueries = sqlite ? vi.spyOn(sqlite.client, "prepare") : undefined;
  const postgresQueries = postgres ? vi.spyOn(postgres.pool, "query") : undefined;
  return {
    scope,
    jobId,
    repository,
    queries: () =>
      sqliteQueries
        ? sqliteQueries.mock.calls.map(([sql]) => sql).join("\n")
        : postgresQueries!.mock.calls
            .map(([sql]) => (typeof sql === "string" ? sql : ""))
            .join("\n"),
    close: async () => {
      sqliteQueries?.mockRestore();
      postgresQueries?.mockRestore();
      if (postgres)
        await postgres.pool.query("DELETE FROM project_versions WHERE id = $1", [
          scope.projectVersionId,
        ]);
      sqlite?.close();
      await postgres?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
