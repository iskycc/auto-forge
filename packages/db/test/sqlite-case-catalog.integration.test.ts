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
