import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { CaseDefinitionService } from "@autoforge/application";
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

const importedCandidate = {
  className: "com.example.CheckoutTest",
  packageName: "com.example",
  simpleName: "CheckoutTest",
  enabled: true,
  classLevelTest: false,
  groups: ["smoke"],
  parameters: { environment: "staging" },
  methods: [
    {
      methodName: "checkout",
      descriptor: "()V",
      enabled: true,
      annotationSource: "method" as const,
      groups: ["smoke"],
      dependsOnMethods: [],
      dependsOnGroups: [],
    },
    {
      methodName: "refund",
      descriptor: "(Ljava/lang/String;)V",
      enabled: true,
      annotationSource: "method" as const,
      groups: [],
      dependsOnMethods: ["checkout"],
      dependsOnGroups: [],
    },
  ],
};

describe("CaseDefinitionService with SQLite catalog", () => {
  it("edits metadata with optimistic revisions and restores version history", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-db-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const catalog = new SqliteCaseCatalogRepository(handle);
    const service = new CaseDefinitionService(
      catalog,
      { now: () => new Date("2026-08-09T00:10:00.000Z") },
      { next: () => `generated-${Math.random().toString(36).slice(2)}` },
    );

    try {
      handle.client
        .prepare(
          `INSERT INTO users
           (id, username, normalized_username, display_name, source, status,
            force_password_change, failed_login_attempts, created_at, updated_at, version)
           VALUES ('actor-1', 'actor-1', 'actor-1', 'Actor One', 'local', 'active', 0, 0, ?, ?, 1),
                  ('actor-2', 'actor-2', 'actor-2', 'Actor Two', 'local', 'active', 0, 0, ?, ?, 1)`,
        )
        .run(
          "2026-08-09T00:00:00.000Z",
          "2026-08-09T00:00:00.000Z",
          "2026-08-09T00:00:00.000Z",
          "2026-08-09T00:00:00.000Z",
        );
      await catalog.importCatalog({
        sourceId: "source-1",
        objectKey: "jars/aa/fixture.jar",
        displayName: "fixture",
        importedAt: "2026-08-09T00:00:00.000Z",
        inspection: {
          schemaVersion: 1,
          fileName: "fixture.jar",
          sha256: "a".repeat(64),
          sizeBytes: 128,
          classFileCount: 1,
          testClassCount: 1,
          testMethodCount: 2,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [importedCandidate],
        },
        cases: [
          {
            caseDefinitionId: "case-1",
            caseVersionId: "case-version-1",
            candidate: importedCandidate,
            methods: [
              { methodId: "method-1", methodIndex: 0 },
              { methodId: "method-2", methodIndex: 1 },
            ],
          },
        ],
      });

      const definition = await service.get("case-1");
      expect(definition).toMatchObject({
        displayName: "CheckoutTest",
        revision: 1,
        currentVersion: 1,
        parameters: { environment: "staging" },
      });
      expect(definition.methods).toHaveLength(2);

      const updated = await service.update(
        "case-1",
        {
          displayName: "结账测试",
          description: "核心链路",
          tags: ["checkout", "core"],
          enabled: false,
          expectedRevision: 1,
        },
        "actor-1",
      );
      expect(updated).toMatchObject({
        displayName: "结账测试",
        description: "核心链路",
        tags: ["checkout", "core"],
        enabled: false,
        revision: 2,
        currentVersion: 1,
        updatedBy: "actor-1",
      });
      await expect(
        service.update("case-1", { displayName: "并发修改", expectedRevision: 1 }, "actor-2"),
      ).rejects.toMatchObject({ code: "CASE_DEFINITION_REVISION_CONFLICT" });

      // 通过仓储写入第二个版本（模拟同步产生的执行内容变更）。
      await catalog.restoreCaseVersion({
        caseDefinitionId: "case-1",
        expectedRevision: 2,
        versionId: "case-version-2",
        version: 2,
        sourceId: "source-1",
        snapshot: {
          ...importedCandidate,
          enabled: true,
          parameters: { environment: "production" },
          methods: [importedCandidate.methods[0]!],
        },
        changeReason: "manual.restore",
        methodIds: ["method-3"],
        actorId: "actor-1",
        restoredAt: "2026-08-09T00:11:00.000Z",
      });
      const atV2 = await service.get("case-1");
      expect(atV2).toMatchObject({ currentVersion: 2, revision: 3, enabled: true });
      expect(atV2.methods.map((method) => method.methodName)).toEqual(["checkout"]);
      expect(atV2.parameters).toEqual({ environment: "production" });

      const versions = await service.listVersions("case-1");
      expect(versions.map((version) => version.version)).toEqual([2, 1]);
      expect(versions[1]?.changeReason).toBe("source.import");

      await expect(service.restoreVersion("case-1", 2, "actor-1")).rejects.toMatchObject({
        code: "CASE_VERSION_ALREADY_CURRENT",
      });
      await expect(service.restoreVersion("case-1", 99, "actor-1")).rejects.toMatchObject({
        code: "CASE_VERSION_NOT_FOUND",
      });

      // 从 v1 恢复：创建 v3，执行内容回到导入快照，元数据保留。
      const restored = await service.restoreVersion("case-1", 1, "actor-2");
      expect(restored).toMatchObject({
        currentVersion: 3,
        displayName: "结账测试",
        tags: ["checkout", "core"],
        parameters: { environment: "staging" },
        updatedBy: "actor-2",
      });
      expect(restored.methods.map((method) => method.methodName)).toEqual(["checkout", "refund"]);
      const afterRestore = await service.listVersions("case-1");
      expect(afterRestore.map((version) => version.version)).toEqual([3, 2, 1]);
      expect(afterRestore[0]).toMatchObject({
        changeReason: "manual.restore",
        createdBy: "actor-2",
      });

      await expect(service.deleteMany(["case-1"], [])).rejects.toMatchObject({
        code: "CASE_DEFINITION_NOT_FOUND",
      });
      await expect(service.get("case-1")).resolves.toMatchObject({ id: "case-1" });

      await expect(service.deleteMany(["case-1"])).resolves.toEqual([
        {
          id: "case-1",
          projectId: "00000000-0000-7000-8000-000000000001",
          displayName: "结账测试",
        },
      ]);
      await expect(service.get("case-1")).rejects.toMatchObject({
        code: "CASE_DEFINITION_NOT_FOUND",
      });
      await expect(catalog.listCaseVersions("case-1", 10)).resolves.toEqual([]);
    } finally {
      handle.close();
    }
  });
});
