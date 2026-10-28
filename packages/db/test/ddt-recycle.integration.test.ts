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

const recordedAt = "2026-10-28T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} DDT recycle folders`,
    () => {
      it("pages normalized SR groups and seeks only the selected folder without reading case payloads", async () => {
        const f = await fixture(dialect);
        try {
          for (const [caseId, srNum] of [
            ["PAY-1", "Pay"],
            ["PAY-2", "pay"],
            ["WALLET", "Wallet"],
            ["中文", "钱包"],
            ["NO-SR", ""],
          ])
            await f.insert(caseId!, srNum!);
          const first = await f.repository.listDeletedGroups({ ...f.scope, limit: 2 });
          expect(first).toMatchObject({
            totalCases: 5,
            totalGroups: 4,
            items: [
              { srNum: "", count: 1 },
              { srNum: "Pay", count: 2 },
            ],
          });
          const second = await f.repository.listDeletedGroups({
            ...f.scope,
            cursor: first.nextCursor!,
            limit: 2,
          });
          expect(second.items).toEqual([
            { srNum: "Wallet", count: 1 },
            { srNum: "钱包", count: 1 },
          ]);
          expect(second.nextCursor).toBeUndefined();
          const cases = await f.repository.listDeletedCases({ ...f.scope, srNum: "PAY", limit: 1 });
          expect(cases.items).toHaveLength(1);
          expect(cases.items[0]).not.toHaveProperty("data");
          const next = await f.repository.listDeletedCases({
            ...f.scope,
            srNum: "PAY",
            cursor: cases.nextCursor!,
            limit: 1,
          });
          expect(new Set([...cases.items, ...next.items].map((item) => item.caseId))).toEqual(
            new Set(["PAY-1", "PAY-2"]),
          );
          expect(
            (await f.repository.listDeletedCases({ ...f.scope, srNum: "", limit: 60 })).items.map(
              (item) => item.caseId,
            ),
          ).toEqual(["NO-SR"]);
        } finally {
          await f.close();
        }
      });
      it("clears every page while preserving later deletions and other stages", async () => {
        const f = await fixture(dialect);
        try {
          for (let index = 0; index < 205; index++)
            await f.insert(`CASE-${index}`, index % 2 ? "Wallet" : "Pay");
          await f.insert("OTHER-STAGE", "Wallet", recordedAt, f.otherStageId);
          const first = await f.repository.purgeDeletedCases({
            ...f.scope,
            deletedBefore: recordedAt,
          });
          expect(first).toEqual({ deletedCount: 200, hasMore: true });
          await f.insert("AFTER-CONFIRMATION", "Wallet", "2026-10-28T00:00:01.000Z");
          expect(
            await f.repository.purgeDeletedCases({ ...f.scope, deletedBefore: recordedAt }),
          ).toEqual({ deletedCount: 5, hasMore: false });
          expect(
            await f.repository.purgeDeletedCases({ ...f.scope, deletedBefore: recordedAt }),
          ).toEqual({ deletedCount: 0, hasMore: false });
          expect(
            (await f.repository.listDeletedCases({ ...f.scope, limit: 60 })).items.map(
              (item) => item.caseId,
            ),
          ).toEqual(["AFTER-CONFIRMATION"]);
          expect(
            (
              await f.repository.listDeletedGroups({
                ...f.scope,
                testStageId: f.otherStageId,
                limit: 30,
              })
            ).totalCases,
          ).toBe(1);
          for (const wrong of [
            { ...f.scope, projectId: "other" },
            { ...f.scope, projectVersionId: "other" },
            { ...f.scope, testStageId: "other" },
          ]) {
            expect((await f.repository.listDeletedGroups({ ...wrong, limit: 30 })).totalCases).toBe(
              0,
            );
            expect(
              await f.repository.purgeDeletedCases({ ...wrong, deletedBefore: recordedAt }),
            ).toEqual({ deletedCount: 0, hasMore: false });
          }
        } finally {
          await f.close();
        }
      });
    },
  );
}

async function fixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-recycle-"));
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
  const otherStageId = randomUUID();
  await structures.createVersion({
    id: scope.projectVersionId,
    projectId: scope.projectId,
    name: scope.projectVersionId,
    normalizedName: scope.projectVersionId,
    recordedAt,
  });
  for (const stageId of [scope.testStageId, otherStageId])
    await structures.createStage({
      ...scope,
      id: stageId,
      name: stageId,
      normalizedName: stageId,
      description: "",
      recordedAt,
    });
  return {
    scope,
    otherStageId,
    repository,
    insert: async (
      caseId: string,
      srNum: string,
      deletedAt = recordedAt,
      testStageId = scope.testStageId,
    ) => {
      const values = [
        randomUUID(),
        randomUUID(),
        scope.projectId,
        scope.projectVersionId,
        testStageId,
        caseId,
        caseId.toLowerCase(),
        srNum,
        srNum.toLowerCase(),
        recordedAt,
        recordedAt,
        deletedAt,
      ];
      const sql = `INSERT INTO ddt_deleted_cases (id,ddt_case_id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,source_name,case_created_at,case_updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,'standard','{}','fixture.xlsx',?,?,?)`;
      if (sqlite) sqlite.client.prepare(sql).run(...values);
      else {
        let position = 0;
        await postgres!.pool.query(
          sql.replaceAll("?", () => `$${++position}`),
          values,
        );
      }
    },
    close: async () => {
      if (postgres)
        await postgres.pool.query("DELETE FROM project_versions WHERE id=$1", [
          scope.projectVersionId,
        ]);
      sqlite?.close();
      await postgres?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
