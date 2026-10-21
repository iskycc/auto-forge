import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";

const now = "2026-10-19T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} DDT category filters`,
    () => {
      it("filters by current SR category, unions exact categories, and keeps pagination, export and scope consistent", async () => {
        const fixture = await createFixture(dialect);
        const { repository, scope, walletId, paymentsId, execute } = fixture;
        const query = { ...scope, categoryIds: [walletId], filters: [], limit: 60 };
        try {
          const first = await repository.listCases(query);
          expect(first.items).toHaveLength(60);
          const last = await repository.listCases({ ...query, cursor: first.nextCursor! });
          expect(last.items).toHaveLength(7);
          expect(last.nextCursor).toBeUndefined();
          expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(67);
          expect(first.items[0]).not.toHaveProperty("data");
          const union = await repository.listCases({
            ...query,
            categoryIds: [walletId, paymentsId, walletId],
            limit: 200,
          });
          expect(union.items).toHaveLength(70);
          expect(
            union.items.some((item) => item.caseId === "PRO" || item.caseId === "UNASSIGNED"),
          ).toBe(false);
          expect(
            (await repository.listCases({ ...query, srNum: "wAlLeT-B", limit: 200 })).items,
          ).toHaveLength(33);
          expect(
            (await repository.listCases({ ...query, query: "066" })).items.map(
              (item) => item.caseId,
            ),
          ).toEqual(["CASE-066"]);
          expect(
            (
              await repository.listCases({
                ...query,
                filters: [{ field: "priority", operator: "eq", value: "P1" }],
              })
            ).items,
          ).toHaveLength(1);
          for (const ids of [[], ["missing"], [`${walletId}-prefix`]]) {
            expect((await repository.listCases({ ...query, categoryIds: ids })).items).toEqual([]);
          }
          for (const wrong of [
            { projectId: "other" },
            { projectVersionId: "other" },
            { testStageId: "other" },
          ]) {
            expect((await repository.listCases({ ...query, ...wrong })).items).toEqual([]);
            expect(
              (
                await repository.listRequirementCategories(
                  { ...scope, ...wrong },
                  { query: "", limit: 100, categoryIds: [walletId] },
                )
              ).items,
            ).toEqual([]);
            expect(
              await repository.exportCases({ ...scope, ...wrong, categoryIds: [walletId] }),
            ).toEqual([]);
          }
          expect(await repository.exportCases({ ...scope, categoryIds: [walletId] })).toHaveLength(
            67,
          );
          expect(await repository.exportCases({ ...scope, categoryIds: [] })).toEqual([]);
          const expectedExport = await repository.exportCases({
            ...scope,
            categoryIds: [walletId],
          });
          const exported = [];
          let cursor: string | undefined;
          do {
            const page = await repository.readExportCasesPage({
              ...scope,
              categoryIds: [walletId],
              ...(cursor ? { cursor } : {}),
            });
            expect(page.items.length).toBeLessThanOrEqual(64);
            exported.push(...page.items);
            cursor = page.nextCursor;
          } while (cursor);
          expect(exported).toEqual(expectedExport);
          expect(await repository.readExportCasesPage({ ...scope, categoryIds: [] })).toEqual({
            items: [],
          });
          expect(
            (
              await repository.readExportCasesPage({
                ...scope,
                caseIds: ["case-066"],
                srNum: "WALLET-A",
              })
            ).items,
          ).toEqual(expectedExport.filter((row) => row.CaseID === "CASE-066"));
          for (const wrong of [
            { projectId: "other" },
            { projectVersionId: "other" },
            { testStageId: "other" },
          ])
            expect((await repository.readExportCasesPage({ ...scope, ...wrong })).items).toEqual(
              [],
            );
          for (let index = 0; index < 5; index++) {
            const caseId = `CASE-${String(index).padStart(3, "0")}`;
            await execute(
              "UPDATE ddt_cases SET data_json = ? WHERE project_version_id = ? AND case_id = ?",
              [
                JSON.stringify({ CaseID: caseId, srNum: "SR", large: "x".repeat(512 * 1_024) }),
                scope.projectVersionId,
                caseId,
              ],
            );
          }
          const bounded = await repository.readExportCasesPage(scope);
          expect(bounded.items).toHaveLength(3);
          expect(bounded.nextCursor).toBe("case-002");

          await execute(
            "UPDATE ddt_requirement_categories SET name = '钱包改名', normalized_name = '钱包改名' WHERE id = ?",
            [walletId],
          );
          expect(
            (
              await repository.listRequirementCategories(scope, {
                query: "",
                limit: 100,
                categoryIds: [walletId],
              })
            ).items,
          ).toMatchObject([{ id: walletId, name: "钱包改名" }]);
          expect((await repository.listCases(query)).items).toHaveLength(60);
          await execute(
            "UPDATE ddt_sr_execution_mappings SET category_id = ? WHERE sr_num_normalized = 'wallet-b' AND project_version_id = ?",
            [paymentsId, scope.projectVersionId],
          );
          expect((await repository.listCases({ ...query, limit: 200 })).items).toHaveLength(34);
          expect(
            (await repository.listCases({ ...query, categoryIds: [paymentsId], limit: 200 })).items,
          ).toHaveLength(36);
        } finally {
          await fixture.close();
        }
      });
    },
  );
}

async function createFixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-category-filter-"));
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
  const scope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: randomUUID(),
    testStageId: randomUUID(),
  };
  const execute = async (sql: string, values: Array<string | number> = []) => {
    if (sqlite) sqlite.client.prepare(sql).run(...values);
    else {
      let index = 0;
      await postgres!.pool.query(
        sql.replaceAll("?", () => `$${++index}`),
        values,
      );
    }
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
  await execute(
    "INSERT INTO ddt_execution_configuration (project_id,project_version_id,test_stage_id) VALUES (?,?,?)",
    Object.values(scope),
  );
  const walletId = randomUUID();
  const paymentsId = randomUUID();
  const proId = randomUUID();
  for (const [id, name] of [
    [walletId, "Wallet"],
    [paymentsId, "Payments"],
    [proId, "WalletPro"],
  ]) {
    await execute(
      "INSERT INTO ddt_requirement_categories (id,project_id,project_version_id,test_stage_id,name,normalized_name,revision,updated_at) VALUES (?,?,?,?,?,?,1,?)",
      [id!, ...Object.values(scope), name!, name!.toLowerCase(), now],
    );
  }
  for (const [sr, id] of [
    ["wallet-a", walletId],
    ["wallet-b", walletId],
    ["payments", paymentsId],
    ["pro", proId],
  ]) {
    await execute(
      "INSERT INTO ddt_sr_execution_mappings (project_id,project_version_id,test_stage_id,sr_num,sr_num_normalized,category_id,revision,updated_at) VALUES (?,?,?,?,?,?,1,?)",
      [...Object.values(scope), sr!, sr!, id!, now],
    );
  }
  for (let index = 0; index < 72; index += 1) {
    const caseId =
      index < 70 ? `CASE-${String(index).padStart(3, "0")}` : index === 70 ? "PRO" : "UNASSIGNED";
    const srNum =
      index < 67
        ? index % 2
          ? "wallet-b"
          : "wallet-a"
        : index < 70
          ? "payments"
          : index === 70
            ? "pro"
            : "none";
    const body = {
      CaseID: caseId,
      srNum,
      CaseName: "Wallet in every body",
      priority: index === 66 ? "P1" : "P2",
    };
    await execute(
      `INSERT INTO ddt_cases (id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,source_name,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'standard',?,'labels.xlsx',?,?)`,
      [
        randomUUID(),
        ...Object.values(scope),
        caseId,
        caseId.toLowerCase(),
        srNum,
        srNum,
        JSON.stringify(body),
        now,
        now,
      ],
    );
  }

  return {
    repository,
    scope,
    walletId,
    paymentsId,
    execute,
    close: async () => {
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
