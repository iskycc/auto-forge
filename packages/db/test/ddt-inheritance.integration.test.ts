import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { inheritDdtCases } from "@autoforge/application";
import { DEFAULT_PROJECT_ID, type DdtCaseData, type DdtScope } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";

const now = "2026-09-22T00:00:00.000Z";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} DDT inheritance`,
    () => {
      it("copies independent standard and journey bodies; skips case-insensitive collisions and repeated requests", async () => {
        const fixture = await createFixture(dialect);
        const { source, target, repository, insert, copy } = fixture;
        try {
          const standard = {
            CaseID: "PAY-1",
            srNum: "PAY",
            CaseName: "支付",
            amount: 3,
            enabled: false,
            note: null,
          };
          const journey = {
            CaseID: "PAY-2",
            srNum: "PAY",
            用户旅程: {
              step1: { CaseID: "PAY-2", srNum: "PAY", value: 0 },
              step2: { value: "下一步" },
            },
          };
          await insert(source, "PAY-1", standard);
          await insert(source, "PAY-2", journey);
          await insert(source, "PAY-3", { CaseID: "PAY-3", srNum: "PAY", value: "source" });
          await insert(target, "pay-3", { CaseID: "pay-3", srNum: "PAY", value: "keep-target" });
          const result = await copy();
          expect(result).toMatchObject({ inheritedCount: 2, skippedCount: 1, nextCursor: "pay-3" });
          expect(await copy(result.nextCursor)).toEqual({ inheritedCount: 0, skippedCount: 0 });
          expect(await copy()).toMatchObject({ inheritedCount: 0, skippedCount: 3 });
          const inherited = await repository.getCase(target, "PAY-1");
          const original = await repository.getCase(source, "PAY-1");
          expect(inherited?.data).toEqual(standard);
          expect(inherited?.id).not.toBe(original?.id);
          expect(inherited?.revision).toBe(1);
          expect(inherited?.sourceName).toBe("继承自旧版本 / 测试阶段");
          expect(inherited?.executionClass).toBeUndefined();
          expect((await repository.getCase(target, "PAY-2"))?.data).toEqual(journey);
          expect((await repository.getCase(target, "PAY-3"))?.data.value).toBe("keep-target");
          expect(
            (await repository.listHistory({ ...target, caseId: "PAY-1", limit: 10 })).items,
          ).toEqual([]);
          await repository.updateCases([
            {
              scope: target,
              caseId: "PAY-1",
              expectedRevision: 1,
              nextData: { ...standard, amount: 99 },
              historyId: randomUUID(),
              historyType: "edit",
              sourceName: "edit",
              updatedAt: now,
            },
          ]);
          expect((await repository.getCase(source, "PAY-1"))?.data.amount).toBe(3);
          await copy();
          expect((await repository.getCase(target, "PAY-1"))?.data.amount).toBe(99);
        } finally {
          await fixture.close();
        }
      });

      it("bounds row count and bytes while resuming; concurrent copies do not duplicate or overwrite", async () => {
        const fixture = await createFixture(dialect);
        try {
          for (let index = 0; index < 70; index++) {
            const caseId = `CASE-${String(index).padStart(3, "0")}`;
            await fixture.insert(fixture.source, caseId, { CaseID: caseId, srNum: "SR" });
          }
          const results = await Promise.all([fixture.copy(), fixture.copy()]);
          expect(results.reduce((sum, page) => sum + page.inheritedCount, 0)).toBe(64);
          expect(results.reduce((sum, page) => sum + page.skippedCount, 0)).toBe(64);
          expect(await fixture.copy(results[0]!.nextCursor)).toMatchObject({
            inheritedCount: 6,
            skippedCount: 0,
          });
          for (let index = 0; index < 3; index++)
            await fixture.insert(fixture.source, `LARGE-${index}`, {
              CaseID: `LARGE-${index}`,
              srNum: "SR",
              body: "x".repeat(900_000),
            });
          const firstLarge = await fixture.copy("case-999");
          expect(firstLarge).toMatchObject({ inheritedCount: 2, nextCursor: "large-1" });
          expect(await fixture.copy(firstLarge.nextCursor)).toMatchObject({ inheritedCount: 1 });
          await fixture.insert(fixture.source, "XL", {
            CaseID: "XL",
            srNum: "SR",
            body: "x".repeat(2_200_000),
          });
          expect(await fixture.copy("large-9")).toMatchObject({
            inheritedCount: 1,
            nextCursor: "xl",
          });
        } finally {
          await fixture.close();
        }
      }, 30_000);

      it("rejects mismatched source and target hierarchy without leaking or writing cases", async () => {
        const fixture = await createFixture(dialect);
        try {
          await fixture.insert(fixture.source, "CASE", { CaseID: "CASE", srNum: "SR" });
          for (const changes of [
            { source: { ...fixture.source, testStageId: fixture.target.testStageId } },
            { target: { ...fixture.target, projectId: "other-project" } },
          ]) {
            await expect(
              fixture.repository.inheritCasesPage({
                source: fixture.source,
                target: fixture.target,
                targetIds: [randomUUID()],
                sourceName: "source",
                inheritedAt: now,
                ...changes,
              }),
            ).rejects.toMatchObject({ code: "DDT_SCOPE_NOT_FOUND" });
          }
          expect(await fixture.repository.getCase(fixture.target, "CASE")).toBeNull();
        } finally {
          await fixture.close();
        }
      });
    },
  );
}

it("Lite inheritance releases the event loop while recovering a short writer lock", async () => {
  const fixture = await createFixture("sqlite");
  const writer = new Database(fixture.databasePath);
  let release: ReturnType<typeof setImmediate> | undefined;
  try {
    await fixture.insert(fixture.source, "CASE", { CaseID: "CASE", srNum: "SR" });
    writer.exec("BEGIN IMMEDIATE");
    release = setImmediate(() => writer.exec("COMMIT"));
    expect(await fixture.copy()).toMatchObject({ inheritedCount: 1 });
    expect(writer.inTransaction).toBe(false);
  } finally {
    clearImmediate(release);
    if (writer.inTransaction) writer.exec("ROLLBACK");
    writer.close();
    await fixture.close();
  }
});

async function createFixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-inheritance-"));
  const databasePath = resolve(directory, "db.sqlite");
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath,
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
          busyTimeoutMs: 25,
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
  const source = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: randomUUID(),
    testStageId: randomUUID(),
  };
  const target = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: randomUUID(),
    testStageId: randomUUID(),
  };
  for (const scope of [source, target]) {
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
  }
  const insert = async (scope: DdtScope, caseId: string, body: DdtCaseData) => {
    const sql = `INSERT INTO ddt_cases
      (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
       sr_num, sr_num_normalized, case_kind, data_json, source_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PAY', 'pay', ?, ?, 'original.xlsx', ?, ?)`;
    const values = [
      randomUUID(),
      scope.projectId,
      scope.projectVersionId,
      scope.testStageId,
      caseId,
      caseId.toLowerCase(),
      body.用户旅程 ? "journey" : "standard",
      JSON.stringify(body),
      now,
      now,
    ];
    if (sqlite) sqlite.client.prepare(sql).run(...values);
    else {
      let index = 0;
      await postgres!.pool.query(
        sql.replace(/\?/g, () => `$${++index}`),
        values,
      );
    }
  };
  return {
    source,
    target,
    repository,
    insert,
    databasePath,
    copy: (cursor?: string) =>
      inheritDdtCases(
        repository,
        { now: () => new Date(now) },
        { next: randomUUID },
        target,
        {
          sourceProjectVersionId: source.projectVersionId,
          sourceTestStageId: source.testStageId,
          ...(cursor ? { cursor } : {}),
        },
        "继承自旧版本 / 测试阶段",
      ),
    close: async () => {
      if (postgres)
        await postgres.pool.query("DELETE FROM project_versions WHERE id = ANY($1::text[])", [
          [source.projectVersionId, target.projectVersionId],
        ]);
      sqlite?.close();
      await postgres?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
