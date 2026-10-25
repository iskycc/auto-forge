import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseSuiteService, type CaseCatalogRepository } from "@autoforge/application";
import { DEFAULT_PROJECT_ID, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";

const now = "2026-10-25T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} task removal by CaseID`,
    () => {
      it("removes only scoped task members, preserves case assets and execution snapshots, and retries idempotently", async () => {
        const f = await fixture(dialect);
        try {
          const selection = await f.service.matchDdtCases(
            f.suiteId,
            {
              projectVersionId: f.scope.projectVersionId,
              testStageId: f.scope.testStageId,
              caseIds: ["移除-Case", "NOT-MEMBER", "MISSING"],
            },
            [f.scope.projectId],
          );
          expect(selection).toEqual({
            items: [{ id: f.removedCaseId, caseId: "移除-CASE" }],
            unmatchedCaseIds: ["NOT-MEMBER", "MISSING"],
          });
          const before = await f.suites.getSummary(f.suiteId);
          const history = await f.read(
            "SELECT id,class_data_json,status FROM execution_runs WHERE batch_id=?",
            [f.batchId],
          );
          await f.service.removeDdtCases(
            f.suiteId,
            selection.items.map((item) => item.id),
          );
          expect((await f.suites.getSummary(f.suiteId))?.revision).toBe(before!.revision + 1);
          expect(
            (await f.suites.get(f.suiteId))?.ddtItems.map((item) => item.ddtCase.id).sort(),
          ).toEqual([f.keepCaseId, f.otherStageCaseId].sort());
          expect(
            (await f.suites.get(f.otherSuiteId))?.ddtItems.map((item) => item.ddtCase.id),
          ).toEqual([f.removedCaseId]);
          expect(await f.ddt.getCase(f.scope, "移除-CASE")).toMatchObject({
            id: f.removedCaseId,
            data: { CaseID: "移除-CASE" },
          });
          expect(
            await f.read("SELECT id,class_data_json,status FROM execution_runs WHERE batch_id=?", [
              f.batchId,
            ]),
          ).toEqual(history);
          const after = await f.suites.getSummary(f.suiteId);
          await f.service.removeDdtCases(f.suiteId, [f.removedCaseId]);
          expect((await f.suites.getSummary(f.suiteId))?.revision).toBe(after!.revision);
          expect(
            await f.service.matchDdtCases(f.suiteId, {
              projectVersionId: f.scope.projectVersionId,
              testStageId: f.scope.testStageId,
              caseIds: ["移除-CASE"],
            }),
          ).toEqual({ items: [], unmatchedCaseIds: ["移除-CASE"] });
        } finally {
          await f.close();
        }
      });
    },
  );
}

async function fixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "suite-ddt-removal-"));
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
  const read = async (sql: string, values: string[] = []): Promise<Record<string, unknown>[]> => {
    if (sqlite) return sqlite.client.prepare(sql).all(...values) as Record<string, unknown>[];
    let index = 0;
    return (
      await postgres!.pool.query(
        sql.replaceAll("?", () => `$${++index}`),
        values,
      )
    ).rows as Record<string, unknown>[];
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
  const structures = sqlite
    ? new SqliteProjectStructureRepository(sqlite)
    : new PostgresProjectStructureRepository(postgres!);
  const ddt = sqlite ? new SqliteDdtRepository(sqlite) : new PostgresDdtRepository(postgres!);
  const suites = sqlite
    ? new SqliteCaseSuiteRepository(sqlite)
    : new PostgresCaseSuiteRepository(postgres!);
  const scope = {
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
  const otherStageId = randomUUID();
  for (const stageId of [scope.testStageId, otherStageId])
    await structures.createStage({
      ...scope,
      id: stageId,
      name: stageId,
      normalizedName: stageId,
      description: "",
      recordedAt: now,
    });
  const removedCaseId = randomUUID(),
    keepCaseId = randomUUID(),
    otherStageCaseId = randomUUID();
  for (const [id, stageId, caseId] of [
    [removedCaseId, scope.testStageId, "移除-CASE"],
    [keepCaseId, scope.testStageId, "KEEP"],
    [otherStageCaseId, otherStageId, "移除-CASE"],
    [randomUUID(), scope.testStageId, "NOT-MEMBER"],
  ]) {
    await execute(
      "INSERT INTO ddt_cases (id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'standard',?,?,?)",
      [
        id!,
        scope.projectId,
        scope.projectVersionId,
        stageId!,
        caseId!,
        caseId!.toLowerCase(),
        "SR",
        "sr",
        JSON.stringify({ CaseID: caseId, srNum: "SR" }),
        now,
        now,
      ],
    );
  }
  const suiteId = randomUUID(),
    otherSuiteId = randomUUID();
  for (const id of [suiteId, otherSuiteId])
    await suites.create({
      id,
      name: id,
      projectId: scope.projectId,
      policy: { ...defaultCaseSuiteExecutionPolicy, projectVersionId: scope.projectVersionId },
      createdAt: now,
    });
  await suites.addDdtCases({
    suiteId,
    items: [removedCaseId, keepCaseId, otherStageCaseId].map((ddtCaseId) => ({
      id: randomUUID(),
      ddtCaseId,
    })),
    versionId: randomUUID(),
    updatedAt: now,
  });
  await suites.addDdtCases({
    suiteId: otherSuiteId,
    items: [{ id: randomUUID(), ddtCaseId: removedCaseId }],
    versionId: randomUUID(),
    updatedAt: now,
  });
  const batchId = randomUUID();
  await execute(
    "INSERT INTO run_batches (id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,created_at,updated_at) VALUES (?,?,?,1,'failed',0,'{}',1,?,?,?)",
    [batchId, suiteId, suiteId, scope.projectId, now, now],
  );
  await execute(
    "INSERT INTO execution_runs (id,batch_id,case_definition_id,case_version,display_name,class_name,case_type,class_data_json,status,created_at,updated_at) VALUES (?,?,?,1,?,'example.Ddt','ddt',?,'failed',?,?)",
    [
      randomUUID(),
      batchId,
      removedCaseId,
      "移除-CASE",
      JSON.stringify({ CaseID: "移除-CASE", srNum: "SR" }),
      now,
      now,
    ],
  );
  const service = new CaseSuiteService(
    suites,
    {} as CaseCatalogRepository,
    structures,
    { now: () => new Date(now) },
    { next: () => randomUUID() },
    undefined,
    ddt,
  );
  return {
    service,
    suites,
    ddt,
    scope,
    suiteId,
    otherSuiteId,
    batchId,
    read,
    removedCaseId,
    keepCaseId,
    otherStageCaseId,
    close: async () => {
      if (postgres) {
        await execute("DELETE FROM run_batches WHERE id=?", [batchId]);
        await execute("DELETE FROM case_suites WHERE id IN (?,?)", [suiteId, otherSuiteId]);
        await execute("DELETE FROM project_versions WHERE id=?", [scope.projectVersionId]);
      }
      sqlite?.close();
      await postgres?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
