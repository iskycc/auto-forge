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
});
