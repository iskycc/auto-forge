import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID, type DdtCaseData } from "@autoforge/domain";
import { searchDdtValues } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} value search`,
    () => {
      it("isolates scope, reads current values, bounds bytes and resumes across sparse matches", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "ddt-value-search-"));
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
        const repository = sqlite
          ? new SqliteDdtRepository(sqlite)
          : new PostgresDdtRepository(postgres!);
        const structures = sqlite
          ? new SqliteProjectStructureRepository(sqlite)
          : new PostgresProjectStructureRepository(postgres!);
        const scope = {
          projectId: DEFAULT_PROJECT_ID,
          projectVersionId: randomUUID(),
          testStageId: randomUUID(),
        };
        const now = "2026-09-16T00:00:00.000Z";
        const execute = async (sql: string, values: Array<string | number> = []) => {
          if (sqlite) return sqlite.client.prepare(sql).run(...values);
          let index = 0;
          return postgres!.pool.query(
            sql.replace(/\?/g, () => `$${++index}`),
            values,
          );
        };
        const insert = (caseId: string, data: DdtCaseData) =>
          execute(
            `INSERT INTO ddt_cases
        (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
         sr_num, sr_num_normalized, case_kind, data_json, source_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'SR', 'sr', 'standard', ?, 'METADATA_ONLY.xlsx', ?, ?)`,
            [
              randomUUID(),
              scope.projectId,
              scope.projectVersionId,
              scope.testStageId,
              caseId,
              caseId.toLowerCase(),
              JSON.stringify(data),
              now,
              now,
            ],
          );
        try {
          await postgres?.ready;
          await structures.createVersion({
            id: scope.projectVersionId,
            projectId: scope.projectId,
            name: scope.projectVersionId,
            normalizedName: scope.projectVersionId,
            recordedAt: now,
          });
          await structures.createStage({
            id: scope.testStageId,
            projectId: scope.projectId,
            projectVersionId: scope.projectVersionId,
            name: "test",
            normalizedName: "test",
            description: "",
            recordedAt: now,
          });
          for (let index = 0; index < 300; index += 1)
            await insert(`CASE-${String(index).padStart(4, "0")}`, { KEY_ONLY: "other" });
          await insert("CASE-0300", {
            value: "钱包 PAYMENT %_\\",
            用户旅程: { step1: { "literal.key[0]": "payment" } },
          });
          const query = { ...scope, keyword: "payment", limit: 20 };
          const firstWindow = await repository.readValueSearchCandidates(scope);
          expect(firstWindow).toHaveLength(256);
          const result = await searchDdtValues(repository, query, async () => "continue");
          expect(result.scannedCount).toBe(301);
          expect(result.nextCursor).toBeUndefined();
          expect(result.items).toMatchObject([
            {
              caseId: "CASE-0300",
              matchCount: 2,
              matches: [{ path: ["value"] }, { path: ["用户旅程", "step1", "literal.key[0]"] }],
            },
          ]);
          const unionQuery = { ...scope, keywords: ["other", "payment", "钱包"], limit: 20 };
          const unionIndex = await searchDdtValues(
            repository,
            { ...unionQuery, indexOffset: 0 },
            async () => "continue",
          );
          expect(unionIndex.scannedCount).toBe(301);
          expect(unionIndex.index?.matchedCount).toBe(301);
          expect(unionIndex.index?.pageCursors).toHaveLength(16);
          const lastPage = await searchDdtValues(
            repository,
            { ...unionQuery, cursor: unionIndex.index!.pageCursors.at(-1) },
            async () => "continue",
          );
          expect(lastPage.items).toEqual(result.items);
          for (const field of ["projectId", "projectVersionId", "testStageId"] as const) {
            expect(
              (
                await searchDdtValues(
                  repository,
                  { ...unionQuery, [field]: "outside" },
                  async () => "continue",
                )
              ).items,
            ).toEqual([]);
          }
          for (const keyword of ["KEY_ONLY", "step1", "METADATA_ONLY", "CASE-0300"]) {
            expect(
              (await searchDdtValues(repository, { ...query, keyword }, async () => "continue"))
                .items,
            ).toEqual([]);
          }
          expect(
            (
              await searchDdtValues(
                repository,
                { ...query, keyword: "%_\\" },
                async () => "continue",
              )
            ).items,
          ).toHaveLength(1);
          for (const field of ["projectId", "projectVersionId", "testStageId"] as const) {
            expect(
              await repository.readValueSearchCandidates({ ...scope, [field]: "outside" }),
            ).toEqual([]);
          }
          await execute(
            "UPDATE ddt_cases SET data_json = ? WHERE project_version_id = ? AND case_id = ?",
            [JSON.stringify({ changed: "new-value" }), scope.projectVersionId, "CASE-0300"],
          );
          expect((await searchDdtValues(repository, query, async () => "continue")).items).toEqual(
            [],
          );
          expect(
            (
              await searchDdtValues(
                repository,
                { ...query, keyword: "new-value" },
                async () => "continue",
              )
            ).items,
          ).toHaveLength(1);
          await execute("DELETE FROM ddt_cases WHERE project_version_id = ? AND case_id = ?", [
            scope.projectVersionId,
            "CASE-0300",
          ]);
          expect(
            (
              await searchDdtValues(
                repository,
                { ...query, keyword: "new-value" },
                async () => "continue",
              )
            ).items,
          ).toEqual([]);

          const large = { a: "中".repeat(400_000), b: "x".repeat(950_000), last: "late-needle" };
          await insert("LARGE-1", large);
          await insert("LARGE-2", large);
          await insert("LARGE-3", { value: "late-needle" });
          const largeWindow = await repository.readValueSearchCandidates(scope, "large-0");
          expect(largeWindow.map((row) => row.caseId)).toEqual(["LARGE-1"]);
          const limited = await searchDdtValues(
            repository,
            { ...query, keyword: "late-needle", cursor: "large-0", limit: 2 },
            async () => "continue",
          );
          expect(limited.items.map((row) => row.caseId)).toEqual(["LARGE-1", "LARGE-2"]);
          expect(limited.nextCursor).toBe("large-2");
          const remainder = await searchDdtValues(
            repository,
            { ...query, keyword: "late-needle", cursor: limited.nextCursor! },
            async () => "continue",
          );
          expect(remainder.items.map((row) => row.caseId)).toEqual(["LARGE-3"]);
          expect(remainder.nextCursor).toBeUndefined();

          for (let index = 0; index < 41; index += 1)
            await insert(`PAGED-${String(index).padStart(3, "0")}`, {
              field: "page-needle",
              another: "page-needle",
            });
          const countPage = await searchDdtValues(
            repository,
            { ...query, keyword: "page-needle", indexOffset: 0 },
            async () => "continue",
          );
          expect(countPage.index?.matchedCount).toBe(41);
          expect(countPage.index?.pageCursors).toHaveLength(3);
          expect(countPage.items).toEqual([]);
          const ids: string[] = [];
          for (const cursor of countPage.index!.pageCursors) {
            const resultPage = await searchDdtValues(
              repository,
              { ...query, keyword: "page-needle", cursor },
              async () => "continue",
            );
            ids.push(...resultPage.items.map((item) => item.caseId));
          }
          expect(ids).toEqual(
            Array.from({ length: 41 }, (_, index) => `PAGED-${String(index).padStart(3, "0")}`),
          );
        } finally {
          if (postgres)
            await postgres.pool.query("DELETE FROM project_versions WHERE id = $1", [
              scope.projectVersionId,
            ]);
          sqlite?.close();
          await postgres?.close();
          await rm(directory, { recursive: true, force: true });
        }
      }, 30_000);
    },
  );
}
