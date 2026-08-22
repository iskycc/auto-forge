import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SqliteCaseCatalogRepository", () => {
  it("imports a source, class version and TestNG methods atomically", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-db-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const repository = new SqliteCaseCatalogRepository(handle);

    try {
      await repository.importCatalog({
        sourceId: "01900000-0000-7000-8000-000000000001",
        objectKey: "jars/aa/fixture.jar",
        displayName: "fixture",
        importedAt: "2026-08-08T10:00:00.000Z",
        inspection: {
          schemaVersion: 1,
          fileName: "fixture.jar",
          sha256: "a".repeat(64),
          sizeBytes: 128,
          classFileCount: 1,
          testClassCount: 1,
          testMethodCount: 1,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [
            {
              className: "com.example.CheckoutTest",
              packageName: "com.example",
              simpleName: "CheckoutTest",
              enabled: true,
              classLevelTest: false,
              groups: ["smoke"],
              methods: [
                {
                  methodName: "checkout",
                  descriptor: "()V",
                  enabled: true,
                  annotationSource: "method",
                  groups: ["smoke"],
                  dependsOnMethods: [],
                  dependsOnGroups: [],
                },
              ],
            },
          ],
        },
        cases: [
          {
            caseDefinitionId: "01900000-0000-7000-8000-000000000002",
            caseVersionId: "01900000-0000-7000-8000-000000000003",
            candidate: {
              className: "com.example.CheckoutTest",
              packageName: "com.example",
              simpleName: "CheckoutTest",
              enabled: true,
              classLevelTest: false,
              groups: ["smoke"],
              methods: [
                {
                  methodName: "checkout",
                  descriptor: "()V",
                  enabled: true,
                  annotationSource: "method",
                  groups: ["smoke"],
                  dependsOnMethods: [],
                  dependsOnGroups: [],
                },
              ],
            },
            methods: [
              {
                methodId: "01900000-0000-7000-8000-000000000004",
                methodIndex: 0,
              },
            ],
          },
        ],
      });

      const summary = await repository.getDashboardSummary();
      const page = await repository.listCases({ limit: 20 });
      const existing = await repository.findSourceBySha256("a".repeat(64));

      expect(summary).toEqual({
        sourceCount: 1,
        caseCount: 1,
        methodCount: 1,
        enabledMethodCount: 1,
      });
      expect(page.items[0]).toMatchObject({
        className: "com.example.CheckoutTest",
        groups: ["smoke"],
        methods: [{ methodName: "checkout" }],
      });
      expect(existing?.sourceId).toBe("01900000-0000-7000-8000-000000000001");
    } finally {
      handle.close();
    }
  });

  it("overwrites a matching class in the same hierarchy and shares a JAR across versions", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-db-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const repository = new SqliteCaseCatalogRepository(handle);
    const projectId = "00000000-0000-7000-8000-000000000001";
    const now = "2026-08-08T10:00:00.000Z";

    try {
      handle.client.exec(`
        INSERT INTO users
          (id, username, normalized_username, display_name, source, status,
           force_password_change, failed_login_attempts, created_at, updated_at, version)
        VALUES ('user-inherit', 'user-inherit', 'user-inherit', 'Inheritance User', 'local',
                'active', 0, 0, '${now}', '${now}', 1);
        INSERT INTO project_versions
          (id, project_id, name, normalized_name, status, revision, created_at, updated_at)
        VALUES
          ('version-a', '${projectId}', 'Version A', 'version a', 'active', 1, '${now}', '${now}'),
          ('version-b', '${projectId}', 'Version B', 'version b', 'active', 1, '${now}', '${now}');
        INSERT INTO test_stages
          (id, project_id, project_version_id, name, normalized_name, description, position,
           status, revision, created_at, updated_at)
        VALUES
          ('stage-a', '${projectId}', 'version-a', 'Stage A', 'stage a', '', 0,
           'active', 1, '${now}', '${now}'),
          ('stage-b', '${projectId}', 'version-b', 'Stage B', 'stage b', '', 0,
           'active', 1, '${now}', '${now}');
      `);

      await repository.importCatalog(
        importRecord({
          sourceId: "source-a1",
          caseDefinitionId: "case-a-stable",
          caseVersionId: "case-a-v1",
          methodId: "method-a-v1",
          objectKey: "jars/shared/content.jar",
          sha256: "a".repeat(64),
          projectId,
          projectVersionId: "version-a",
          testStageId: "stage-a",
          methodName: "beforeReimport",
          importedAt: now,
        }),
      );
      handle.client
        .prepare(
          "UPDATE case_definitions SET display_name = ?, description = ?, tags_json = ? WHERE id = ?",
        )
        .run("人工名称", "人工说明", '["manual"]', "case-a-stable");

      // 模拟旧版按 source + class 唯一约束时已经留下的同层级重复用例。
      const legacyDuplicate = importRecord({
        sourceId: "source-a-legacy-duplicate",
        caseDefinitionId: "case-a-legacy-duplicate",
        caseVersionId: "case-a-legacy-duplicate-v1",
        methodId: "method-a-legacy-duplicate",
        objectKey: "jars/legacy-duplicate/content.jar",
        sha256: "d".repeat(64),
        projectId,
        projectVersionId: "version-a",
        testStageId: "stage-a",
        methodName: "legacyDuplicate",
        importedAt: "2026-08-08T10:30:00.000Z",
      });
      handle.client
        .prepare(
          `INSERT INTO case_sources
           (id, project_id, project_version_id, test_stage_id, display_name, original_file_name,
            object_key, sha256, size_bytes, class_count, method_count, status, warnings_json,
            inspection_json, authoritative, lifecycle_status, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', '[]', ?, 0, 'active', 1, ?, ?)`,
        )
        .run(
          legacyDuplicate.sourceId,
          projectId,
          "version-a",
          "stage-a",
          legacyDuplicate.displayName,
          legacyDuplicate.inspection.fileName,
          legacyDuplicate.objectKey,
          legacyDuplicate.inspection.sha256,
          legacyDuplicate.inspection.sizeBytes,
          legacyDuplicate.inspection.testClassCount,
          legacyDuplicate.inspection.testMethodCount,
          JSON.stringify(legacyDuplicate.inspection),
          legacyDuplicate.importedAt,
          legacyDuplicate.importedAt,
        );
      handle.client
        .prepare(
          `INSERT INTO case_definitions
           (id, project_id, project_version_id, test_stage_id, directory_path, source_id,
            class_name, package_name, display_name, description, tags_json, parameters_json,
            enabled, archived, revision, groups_json, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'com/example', ?, ?, 'com.example', 'Legacy duplicate', '', '[]',
                   '{}', 1, 0, 1, '["smoke"]', 1, ?, ?)`,
        )
        .run(
          "case-a-legacy-duplicate",
          projectId,
          "version-a",
          "stage-a",
          legacyDuplicate.sourceId,
          legacyDuplicate.cases[0]!.candidate.className,
          legacyDuplicate.importedAt,
          legacyDuplicate.importedAt,
        );
      handle.client
        .prepare(
          `INSERT INTO case_versions
           (id, case_definition_id, source_id, version, snapshot_json, change_reason, created_at)
           VALUES (?, ?, ?, 1, ?, 'source.import', ?)`,
        )
        .run(
          "case-a-legacy-duplicate-v1",
          "case-a-legacy-duplicate",
          legacyDuplicate.sourceId,
          JSON.stringify(legacyDuplicate.cases[0]!.candidate),
          legacyDuplicate.importedAt,
        );
      handle.client
        .prepare(
          `INSERT INTO case_suites
           (id, project_id, name, version, status, enabled, revision, policy_json, created_at, updated_at)
           VALUES ('suite-legacy-duplicate', ?, 'Legacy suite', 1, 'active', 1, 1, '{}', ?, ?)`,
        )
        .run(projectId, now, now);
      handle.client
        .prepare(
          `INSERT INTO case_suite_items (id, suite_id, case_definition_id, added_at)
           VALUES ('suite-item-legacy-duplicate', 'suite-legacy-duplicate', ?, ?)`,
        )
        .run("case-a-legacy-duplicate", legacyDuplicate.importedAt);

      await repository.importCatalog(
        importRecord({
          sourceId: "source-a2",
          caseDefinitionId: "case-a-unused",
          caseVersionId: "case-a-v2",
          methodId: "method-a-v2",
          objectKey: "jars/changed/content.jar",
          sha256: "b".repeat(64),
          projectId,
          projectVersionId: "version-a",
          testStageId: "stage-a",
          methodName: "afterReimport",
          importedAt: "2026-08-08T11:00:00.000Z",
        }),
      );

      const versionA = await repository.listCases({
        projectIds: [projectId],
        projectVersionId: "version-a",
        testStageId: "stage-a",
        limit: 20,
      });
      expect(versionA.items).toHaveLength(1);
      expect(versionA.items[0]).toMatchObject({
        id: "case-a-stable",
        sourceId: "source-a2",
        displayName: "人工名称",
        description: "人工说明",
        tags: ["manual"],
        currentVersion: 3,
        methods: [{ id: "method-a-v2", methodName: "afterReimport" }],
      });
      expect(
        (await repository.listCaseVersions("case-a-stable", 10)).map((item) => [
          item.version,
          item.changeReason,
        ]),
      ).toEqual([
        [3, "source.reimport"],
        [2, "source.import"],
        [1, "source.import"],
      ]);
      expect(await repository.getCaseDefinition("case-a-legacy-duplicate")).toBeNull();
      expect(
        handle.client
          .prepare(
            "SELECT case_definition_id FROM case_suite_items WHERE id = 'suite-item-legacy-duplicate'",
          )
          .get(),
      ).toEqual({ case_definition_id: "case-a-stable" });

      await expect(
        repository.inheritCaseDefinitions({
          projectId,
          sourceProjectVersionId: "version-a",
          sourceTestStageId: "stage-a",
          targetProjectVersionId: "version-b",
          targetTestStageId: "stage-b",
          records: [
            {
              sourceCaseDefinitionId: "case-a-stable",
              targetCaseDefinitionId: "case-inherited",
              targetCaseVersionId: "case-inherited-v1",
              methods: [{ sourceMethodId: "method-a-v2", targetMethodId: "method-inherited-v1" }],
            },
          ],
          actorId: "user-inherit",
          inheritedAt: "2026-08-08T11:30:00.000Z",
        }),
      ).resolves.toEqual({ inheritedCount: 1, skippedCount: 0 });
      await expect(
        repository.inheritCaseDefinitions({
          projectId,
          sourceProjectVersionId: "version-a",
          sourceTestStageId: "stage-a",
          targetProjectVersionId: "version-b",
          targetTestStageId: "stage-b",
          records: [
            {
              sourceCaseDefinitionId: "case-a-stable",
              targetCaseDefinitionId: "case-inherited-duplicate",
              targetCaseVersionId: "case-inherited-duplicate-v1",
              methods: [],
            },
          ],
          actorId: "user-inherit",
          inheritedAt: "2026-08-08T11:31:00.000Z",
        }),
      ).resolves.toEqual({ inheritedCount: 0, skippedCount: 1 });

      await repository.importCatalog(
        importRecord({
          sourceId: "source-b1",
          caseDefinitionId: "case-b",
          caseVersionId: "case-b-v1",
          methodId: "method-b-v1",
          objectKey: "jars/shared/content.jar",
          sha256: "a".repeat(64),
          projectId,
          projectVersionId: "version-b",
          testStageId: "stage-b",
          methodName: "beforeReimport",
          importedAt: "2026-08-08T12:00:00.000Z",
        }),
      );
      expect(
        await repository.findSourceBySha256("a".repeat(64), projectId, "version-b", "stage-b"),
      ).toMatchObject({ sourceId: "source-b1" });
      expect(
        await repository.listCases({
          projectIds: [projectId],
          projectVersionId: "version-b",
          testStageId: "stage-b",
          limit: 20,
        }),
      ).toMatchObject({
        items: [
          {
            id: "case-inherited",
            sourceId: "source-b1",
            currentVersion: 2,
            methods: [{ id: "method-b-v1", methodName: "beforeReimport" }],
          },
        ],
      });
    } finally {
      handle.close();
    }
  });

  it("lists the latest terminal run outcome per case definition", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-db-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const repository = new SqliteCaseCatalogRepository(handle);

    try {
      seedLatestRunFixture(handle.client);

      // 每用例多条 run：取最新终态 run（succeeded 之后又被超时失败覆盖）。
      // 最新 run 尚未终态时回退到更早的终态 run；仅有排队中 run 的用例不返回。
      const outcomes = await repository.listLatestRunOutcomes([
        "case-multi",
        "case-stale",
        "case-queued-only",
        "case-cancelled",
        "case-null-outcome",
        "case-unknown",
      ]);

      expect(new Map(outcomes.map((entry) => [entry.caseDefinitionId, entry]))).toEqual(
        new Map([
          [
            "case-multi",
            {
              caseDefinitionId: "case-multi",
              outcome: "timed_out",
              executedAt: "2026-08-12T02:00:00.000Z",
            },
          ],
          [
            "case-stale",
            {
              caseDefinitionId: "case-stale",
              outcome: "failed",
              executedAt: "2026-08-12T01:00:00.000Z",
            },
          ],
          [
            "case-cancelled",
            {
              caseDefinitionId: "case-cancelled",
              outcome: "cancelled",
              executedAt: "2026-08-12T01:30:00.000Z",
            },
          ],
          [
            "case-null-outcome",
            {
              caseDefinitionId: "case-null-outcome",
              outcome: "succeeded",
              executedAt: "2026-08-12T01:15:00.000Z",
            },
          ],
        ]),
      );
      expect(await repository.listLatestRunOutcomes([])).toEqual([]);
    } finally {
      handle.close();
    }
  });
});

function importRecord(input: {
  sourceId: string;
  caseDefinitionId: string;
  caseVersionId: string;
  methodId: string;
  objectKey: string;
  sha256: string;
  projectId: string;
  projectVersionId: string;
  testStageId: string;
  methodName: string;
  importedAt: string;
}) {
  const candidate = {
    className: "com.example.SameTest",
    packageName: "com.example",
    simpleName: "SameTest",
    enabled: true,
    classLevelTest: false,
    groups: ["smoke"],
    methods: [
      {
        methodName: input.methodName,
        descriptor: "()V",
        enabled: true,
        annotationSource: "method" as const,
        groups: ["smoke"],
        dependsOnMethods: [],
        dependsOnGroups: [],
      },
    ],
  };
  return {
    sourceId: input.sourceId,
    projectId: input.projectId,
    projectVersionId: input.projectVersionId,
    testStageId: input.testStageId,
    objectKey: input.objectKey,
    displayName: input.sourceId,
    importedAt: input.importedAt,
    inspection: {
      schemaVersion: 1 as const,
      fileName: `${input.sourceId}.jar`,
      sha256: input.sha256,
      sizeBytes: 128,
      classFileCount: 1,
      testClassCount: 1,
      testMethodCount: 1,
      hasRootTestNgXml: false,
      discoveryMode: "bytecode-annotations" as const,
      warnings: [],
      classes: [candidate],
    },
    cases: [
      {
        caseDefinitionId: input.caseDefinitionId,
        caseVersionId: input.caseVersionId,
        candidate,
        methods: [{ methodId: input.methodId, methodIndex: 0 }],
      },
    ],
  };
}

// 只插入 execution_runs 及其批次外键依赖；listLatestRunOutcomes 按
// case_definition_id 分组，不要求用例记录本身存在。
function seedLatestRunFixture(client: { exec(sql: string): void }): void {
  client.exec(`
    INSERT INTO run_batches
      (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
       secret_bindings_json, total_runs, project_id, priority, created_at, updated_at)
    VALUES
      ('batch-earlier', 'suite-latest', 'Latest', 1, 'running', 0, '[]', '[]', 3,
       'project-latest', 0, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z'),
      ('batch-later', 'suite-latest', 'Latest', 1, 'running', 0, '[]', '[]', 3,
       'project-latest', 0, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    INSERT INTO execution_runs
      (id, batch_id, case_definition_id, case_version, display_name, class_name,
       parameters_json, status, terminal_outcome, attempt_count, created_at, updated_at)
    VALUES
      ('run-a1', 'batch-earlier', 'case-multi', 1, 'Multi', 'com.example.Multi', '{}',
       'succeeded', 'succeeded', 1, '2026-08-12T01:00:00.000Z', '2026-08-12T01:00:00.000Z'),
      ('run-a2', 'batch-later', 'case-multi', 1, 'Multi', 'com.example.Multi', '{}',
       'failed', 'timed_out', 1, '2026-08-12T02:00:00.000Z', '2026-08-12T02:00:00.000Z'),
      ('run-b1', 'batch-earlier', 'case-stale', 1, 'Stale', 'com.example.Stale', '{}',
       'failed', 'failed', 1, '2026-08-12T01:00:00.000Z', '2026-08-12T01:00:00.000Z'),
      ('run-b2', 'batch-later', 'case-stale', 1, 'Stale', 'com.example.Stale', '{}',
       'running', NULL, 0, '2026-08-12T03:00:00.000Z', '2026-08-12T03:00:00.000Z'),
      ('run-c1', 'batch-later', 'case-queued-only', 1, 'Queued', 'com.example.Queued', '{}',
       'queued', NULL, 0, '2026-08-12T03:00:00.000Z', '2026-08-12T03:00:00.000Z'),
      ('run-d1', 'batch-earlier', 'case-cancelled', 1, 'Cancelled', 'com.example.Cancelled', '{}',
       'cancelled', 'cancelled', 1, '2026-08-12T01:30:00.000Z', '2026-08-12T01:30:00.000Z'),
      ('run-e1', 'batch-earlier', 'case-null-outcome', 1, 'Legacy', 'com.example.Legacy', '{}',
       'succeeded', NULL, 1, '2026-08-12T01:15:00.000Z', '2026-08-12T01:15:00.000Z');
  `);
}
