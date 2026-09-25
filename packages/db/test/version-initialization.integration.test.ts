import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CaseSuiteService,
  DdtCaseService,
  VersionInitializationService,
  inheritedSuiteId,
} from "@autoforge/application";
import { versionInitializationInputSchema, type TestNgClassCandidate } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import {
  PostgresCaseCatalogRepository,
  PostgresCaseSuiteRepository,
} from "../src/postgres-platform-repository";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";

const now = "2026-09-26T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} version initialization`,
    () => {
      it("inherits independent assets, maps SR classes and mixed task members into the target, and resumes without overwriting", async () => {
        const f = await fixture(dialect);
        try {
          const first = await f.apply("stage");
          expect(first.targetTestStageId).toBe(f.target.testStageId);
          expect(first.skippedCount).toBe(1);
          expect((await f.apply("runtime")).inheritedCount).toBe(1);
          expect((await f.apply("runtime")).skippedCount).toBe(1);
          expect((await f.apply("testng")).inheritedCount).toBe(1);
          expect((await f.apply("ddt")).inheritedCount).toBe(1);
          for (const step of ["range", "categories", "sr"] as const) await f.apply(step);
          const sourceCase = await f.ddt.getCase(f.source, "PAY-1");
          const targetCase = await f.ddt.getCase(f.target, "PAY-1");
          expect(targetCase?.id).not.toBe(sourceCase?.id);
          expect(targetCase?.executionClass?.caseDefinitionId).not.toBe(f.classId);
          expect(targetCase?.executionClass?.className).toBe("com.example.PaymentTest");
          const sourceSuite = await f.caseSuites.create({
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: f.source.projectVersionId,
            name: "Mixed regression",
          });
          await f.caseSuites.addCases(sourceSuite.id, [f.classId]);
          const revision = (
            await f.caseSuites.addDdtCases(sourceSuite.id, f.source.testStageId, ["PAY-1"])
          ).revision;
          const input = { sourceSuiteId: sourceSuite.id, sourceSuiteRevision: revision };
          const copies = await Promise.all([f.apply("suite", input), f.apply("suite", input)]);
          expect(copies[0]!.targetSuiteId).toBe(copies[1]!.targetSuiteId);
          const targetSuiteId = inheritedSuiteId(sourceSuite.id, f.target.projectVersionId);
          const copied = await f.suites.get(targetSuiteId);
          expect(copied).toMatchObject({
            enabled: false,
            caseCount: 2,
            policy: { projectVersionId: f.target.projectVersionId },
          });
          expect(copied?.items[0]?.caseDefinition.id).toBe(
            targetCase?.executionClass?.caseDefinitionId,
          );
          expect(copied?.ddtItems?.[0]?.ddtCase.id).toBe(targetCase?.id);
          await f.caseSuites.update(targetSuiteId, {
            expectedRevision: copied!.revision,
            name: "Target maintained independently",
          });
          const beforeRetry = await f.suites.getSummary(targetSuiteId);
          await f.apply("suite", input);
          expect((await f.suites.getSummary(targetSuiteId))?.revision).toBe(beforeRetry?.revision);
          expect((await f.suites.get(targetSuiteId))?.name).toBe("Target maintained independently");
          expect((await f.suites.get(targetSuiteId))?.caseCount).toBe(2);
          expect((await f.apply("testng")).skippedCount).toBe(1);
          expect((await f.apply("ddt")).skippedCount).toBe(1);
          expect((await f.apply("sr")).skippedCount).toBe(1);
          expect((await f.suites.get(sourceSuite.id))?.enabled).toBe(true);
        } finally {
          await f.close();
        }
      }, 30_000);

      it("reuses a concurrently inherited stage and rejects invalid cursors before creating tasks", async () => {
        const f = await fixture(dialect);
        try {
          const stage = await f.structures.createStage({
            ...f.source,
            id: randomUUID(),
            name: "UAT",
            normalizedName: "uat",
            description: "",
            recordedAt: now,
          });
          const inherited = await Promise.all([
            f.apply("stage", { sourceTestStageId: stage.id }),
            f.apply("stage", { sourceTestStageId: stage.id }),
          ]);
          expect(inherited[0]?.targetTestStageId).toBe(inherited[1]?.targetTestStageId);
          expect(inherited.reduce((sum, item) => sum + item.inheritedCount, 0)).toBe(1);
          const source = await f.caseSuites.create({
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: f.source.projectVersionId,
            name: "Cursor guard",
          });
          const input = { sourceSuiteId: source.id, sourceSuiteRevision: source.revision };
          await expect(
            f.apply("suite", { ...input, cursor: "invalid-json" }),
          ).rejects.toMatchObject({ code: "VERSION_INITIALIZATION_CURSOR_INVALID" });
          await expect(
            f.apply("suite", {
              ...input,
              stageMappings: [
                {
                  sourceTestStageId: f.source.testStageId,
                  targetTestStageId: f.source.testStageId,
                },
              ],
            }),
          ).rejects.toMatchObject({ code: "VERSION_INITIALIZATION_STAGE_INVALID" });
          expect(
            await f.suites.getSummary(inheritedSuiteId(source.id, f.target.projectVersionId)),
          ).toBeNull();
        } finally {
          await f.close();
        }
      }, 30_000);

      it("finds exact categories beyond a page of similar names and keeps their configuration", async () => {
        const f = await fixture(dialect);
        try {
          await f.apply("testng");
          await f.apply("range");
          const executionClass = await f.ddt.findExecutionClass(
            f.target,
            "com.example.PaymentTest",
          );
          for (let index = 0; index < 105; index++) {
            await f.ddt.saveRequirementCategory({
              scope: f.target,
              id: randomUUID(),
              name: `其他支付分类${index}`,
              executionCaseDefinitionId: executionClass!.caseDefinitionId,
              expectedRevision: 0,
              updatedAt: now,
            });
          }
          const exactId = "ffffffff-ffff-8fff-afff-" + randomUUID().slice(-12);
          await f.ddt.saveRequirementCategory({
            scope: f.target,
            id: exactId,
            name: "支付",
            executionCaseDefinitionId: executionClass!.caseDefinitionId,
            expectedRevision: 0,
            updatedAt: now,
          });
          expect(
            (
              await f.ddt.listRequirementCategories(f.target, { query: "支付", limit: 100 })
            ).items.some((item) => item.id === exactId),
          ).toBe(false);
          expect(await f.apply("categories")).toMatchObject({ inheritedCount: 0, skippedCount: 1 });
          await f.apply("ddt");
          await f.apply("sr");
          expect((await f.ddt.getCase(f.target, "PAY-1"))?.executionClass?.caseDefinitionId).toBe(
            executionClass!.caseDefinitionId,
          );
        } finally {
          await f.close();
        }
      }, 30_000);

      it("continues mixed task membership across bounded pages without duplicating either member type", async () => {
        const f = await fixture(dialect);
        try {
          const extraIds = Array.from({ length: 54 }, (_, index) => `PAY-${index + 2}`);
          for (const caseId of extraIds) await f.addDdtCase(caseId);
          await f.apply("testng");
          let cursor: string | undefined;
          do {
            cursor = (await f.apply("ddt", cursor ? { cursor } : {})).nextCursor;
          } while (cursor);
          const source = await f.caseSuites.create({
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: f.source.projectVersionId,
            name: "Paged mixed task",
          });
          await f.caseSuites.addCases(source.id, [f.classId]);
          const revision = (
            await f.caseSuites.addDdtCases(source.id, f.source.testStageId, ["PAY-1", ...extraIds])
          ).revision;
          const input = { sourceSuiteId: source.id, sourceSuiteRevision: revision };
          const first = await f.apply("suite", input);
          expect(first.inheritedCount).toBe(51);
          expect(first.nextCursor).toBeDefined();
          const second = await f.apply("suite", { ...input, cursor: first.nextCursor });
          expect(second).toMatchObject({ inheritedCount: 5, skippedCount: 0 });
          expect(second.nextCursor).toBeUndefined();
          const copied = await f.suites.getSummary(first.targetSuiteId!);
          expect(copied?.caseCount).toBe(56);
          await f.apply("suite", input);
          await f.apply("suite", { ...input, cursor: first.nextCursor });
          expect((await f.suites.getSummary(first.targetSuiteId!))?.revision).toBe(
            copied?.revision,
          );
        } finally {
          await f.close();
        }
      }, 30_000);

      it("deduplicates ordinary members when source stages map into one target stage", async () => {
        const f = await fixture(dialect);
        try {
          const otherStage = await f.structures.createStage({
            ...f.source,
            id: randomUUID(),
            name: "UAT",
            normalizedName: "uat",
            description: "",
            recordedAt: now,
          });
          const otherClass = await f.addOrdinaryClass(otherStage.id);
          await f.apply("testng");
          const source = await f.caseSuites.create({
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: f.source.projectVersionId,
            name: "Merge stages",
          });
          const revision = (await f.caseSuites.addCases(source.id, [f.classId, otherClass]))
            .revision;
          const result = await f.apply("suite", {
            sourceSuiteId: source.id,
            sourceSuiteRevision: revision,
            stageMappings: [
              { sourceTestStageId: otherStage.id, targetTestStageId: f.target.testStageId },
            ],
          });
          expect(result).toMatchObject({ inheritedCount: 1, skippedCount: 1 });
          expect((await f.suites.getSummary(result.targetSuiteId!))?.caseCount).toBe(1);
        } finally {
          await f.close();
        }
      }, 30_000);

      it("allows an empty version, rejects unrelated scopes and reports unmet prerequisites without fabricating links", async () => {
        const f = await fixture(dialect);
        try {
          expect(
            (await f.catalog.listCases({ projectVersionId: f.target.projectVersionId, limit: 10 }))
              .items,
          ).toHaveLength(0);
          expect((await f.apply("categories")).warnings[0]).toContain("目标阶段缺少对应测试类");
          await expect(
            f.service.apply(
              DEFAULT_PROJECT_ID,
              f.target.projectVersionId,
              versionInitializationInputSchema.parse({
                sourceProjectVersionId: "unrelated",
                step: "runtime",
              }),
            ),
          ).rejects.toMatchObject({ code: "VERSION_INITIALIZATION_SCOPE_INVALID" });
          await expect(
            f.apply("testng", { targetTestStageId: f.source.testStageId }),
          ).rejects.toMatchObject({ code: "VERSION_INITIALIZATION_STAGE_INVALID" });
          const sourceSuite = await f.caseSuites.create({
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: f.source.projectVersionId,
            name: "Configuration only",
          });
          await f.caseSuites.addCases(sourceSuite.id, [f.classId]);
          await expect(
            f.apply("suite", {
              sourceSuiteId: sourceSuite.id,
              sourceSuiteRevision: sourceSuite.revision,
            }),
          ).rejects.toMatchObject({ code: "CASE_SUITE_REVISION_CONFLICT" });
          const current = await f.suites.getSummary(sourceSuite.id);
          const result = await f.apply("suite", {
            sourceSuiteId: sourceSuite.id,
            sourceSuiteRevision: current!.revision,
            includeCases: false,
          });
          expect(await f.suites.getSummary(result.targetSuiteId!)).toMatchObject({
            caseCount: 0,
            enabled: false,
          });
        } finally {
          await f.close();
        }
      }, 30_000);
    },
  );
}

async function fixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-version-init-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "test.sqlite"),
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
  const structures = sqlite
    ? new SqliteProjectStructureRepository(sqlite)
    : new PostgresProjectStructureRepository(postgres!);
  const catalog = sqlite
    ? new SqliteCaseCatalogRepository(sqlite)
    : new PostgresCaseCatalogRepository(postgres!);
  const suites = sqlite
    ? new SqliteCaseSuiteRepository(sqlite)
    : new PostgresCaseSuiteRepository(postgres!);
  const ddt = sqlite ? new SqliteDdtRepository(sqlite) : new PostgresDdtRepository(postgres!);
  const clock = { now: () => new Date(now) };
  const ids = { next: randomUUID };
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
      name: "SIT",
      normalizedName: "sit",
      description: "System testing",
      recordedAt: now,
    });
  }
  const asset = await structures.createRuntimeAsset({
    id: randomUUID(),
    projectId: DEFAULT_PROJECT_ID,
    kind: "jar-bundle",
    sourceType: "url",
    fileName: "all-jars.zip",
    url: "https://example.invalid/all-jars.zip",
    sha256: "a".repeat(64),
    sizeBytes: 1,
    archiveFormat: "zip",
    createdAt: now,
  });
  const config = await structures.getAdapterConfiguration(
    DEFAULT_PROJECT_ID,
    source.projectVersionId,
  );
  await structures.updateAdapterConfiguration({
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: source.projectVersionId,
    jarBundleAssetId: asset.id,
    expectedRevision: config.revision,
    updatedAt: now,
  });
  const classId = randomUUID();
  const candidate: TestNgClassCandidate = {
    className: "com.example.PaymentTest",
    packageName: "com.example",
    simpleName: "PaymentTest",
    enabled: true,
    classLevelTest: true,
    groups: [],
    methods: [],
  };
  async function addOrdinaryClass(testStageId: string, id = randomUUID()) {
    await catalog.importCatalog({
      ...source,
      testStageId,
      sourceId: randomUUID(),
      objectKey: `jars/${randomUUID()}.jar`,
      displayName: "payment.jar",
      importedAt: now,
      inspection: {
        schemaVersion: 1,
        fileName: "payment.jar",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        classFileCount: 1,
        testClassCount: 1,
        testMethodCount: 0,
        hasRootTestNgXml: false,
        discoveryMode: "bytecode-annotations",
        warnings: [],
        classes: [candidate],
      },
      cases: [{ caseDefinitionId: id, caseVersionId: randomUUID(), candidate, methods: [] }],
    });
    return id;
  }
  await addOrdinaryClass(source.testStageId, classId);
  const sql = `INSERT INTO ddt_cases (id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,source_name,created_at,updated_at) VALUES (?, ?, ?, ?, 'PAY-1','pay-1','PAY','pay','standard',?,'original.xlsx',?,?)`;
  const values = [
    randomUUID(),
    DEFAULT_PROJECT_ID,
    source.projectVersionId,
    source.testStageId,
    JSON.stringify({ CaseID: "PAY-1", srNum: "PAY", amount: 1 }),
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
  const ddtService = new DdtCaseService(ddt, clock, ids);
  await ddtService.changeExecutionClassRange(source, {
    caseDefinitionId: classId,
    className: candidate.className,
    included: true,
    expectedRevision: 0,
  });
  const category = await ddtService.saveRequirementCategory(source, {
    name: "支付",
    className: candidate.className,
    expectedRevision: 0,
  });
  await ddtService.setSrCategory(source, {
    srNum: "PAY",
    categoryId: category.id,
    expectedRevision: 0,
  });
  const caseSuites = new CaseSuiteService(suites, catalog, structures, clock, ids, undefined, ddt);
  const service = new VersionInitializationService({
    structures,
    catalog,
    suites,
    ddt,
    caseSuites,
    clock,
    ids,
  });
  return {
    source,
    target,
    ddt,
    suites,
    catalog,
    structures,
    caseSuites,
    service,
    classId,
    addOrdinaryClass,
    addDdtCase: async (caseId: string) => {
      const extraValues = [
        randomUUID(),
        DEFAULT_PROJECT_ID,
        source.projectVersionId,
        source.testStageId,
        caseId,
        caseId.toLowerCase(),
        JSON.stringify({ CaseID: caseId, srNum: "PAY" }),
        now,
        now,
      ];
      const insert = sql.replace("'PAY-1','pay-1'", "?,?");
      if (sqlite) sqlite.client.prepare(insert).run(...extraValues);
      else {
        let index = 0;
        await postgres!.pool.query(
          insert.replace(/\?/g, () => `$${++index}`),
          extraValues,
        );
      }
    },
    apply: (step: string, changes: Record<string, unknown> = {}) =>
      service.apply(
        DEFAULT_PROJECT_ID,
        target.projectVersionId,
        versionInitializationInputSchema.parse({
          step,
          sourceProjectVersionId: source.projectVersionId,
          sourceTestStageId: source.testStageId,
          targetTestStageId: target.testStageId,
          ...changes,
        }),
      ),
    close: async () => {
      sqlite?.close();
      await postgres?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
