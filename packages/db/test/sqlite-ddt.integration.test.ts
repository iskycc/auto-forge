import { SqliteWriterContention } from "./sqlite-writer-contention";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import {
  expectDdtSrExecutionContract,
  expectDdtUnavailableSourceContract,
} from "./ddt-sr-execution-contract";
import { ddtLiteralSearchFields, expectDdtCaseSearch } from "./ddt-search-contract";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";

import type { JobEnvelope } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";

const temporaryDirectories: string[] = [];
const now = "2026-08-24T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite DDT repository", () => {
  it.each(["assign", "change", "unlink", "create", "edit", "delete", "range"] as const)(
    "recovers %s after a short writer lock while yielding to other requests",
    async (operation) => {
      const { handle, repository, scope, category, assignment, candidate } =
        await categoryFixture();
      const writer = new Database(handle.client.name);
      let release: ReturnType<typeof setImmediate> | undefined;
      try {
        const mutations = {
          assign: () => repository.setSrExecutionClass({ ...assignment, srNum: "SECOND" }),
          change: () =>
            repository.setSrExecutionClass({
              ...assignment,
              categoryId: "payments",
              expectedRevision: 1,
            }),
          unlink: () =>
            repository.setSrExecutionClass({
              ...assignment,
              categoryId: null,
              expectedRevision: 1,
            }),
          create: () =>
            repository.saveRequirementCategory({ ...category, id: "new", name: "New category" }),
          edit: () =>
            repository.saveRequirementCategory({
              ...category,
              name: "Updated wallet",
              expectedRevision: 1,
            }),
          delete: () =>
            repository.deleteRequirementCategory({ scope, id: "payments", expectedRevision: 1 }),
          range: () => repository.changeExecutionClassRange({ ...candidate, expectedRevision: 1 }),
        };
        writer.exec("BEGIN IMMEDIATE");
        // The same event loop must be able to release the other connection's lock.
        release = setImmediate(() => writer.exec("COMMIT"));
        await mutations[operation]();
        expect(writer.inTransaction).toBe(false);
        expect(handle.client.pragma("busy_timeout", { simple: true })).toBe(25);
        const mappings = await repository.listSrExecutionMappings(scope, { query: "", limit: 10 });
        const order = mappings.items.find((item) => item.srNum === "ORDER");
        expect(order).toMatchObject({
          revision: operation === "change" || operation === "unlink" ? 2 : 1,
        });
        if (operation === "unlink") {
          expect(order?.category).toBeUndefined();
          expect(order?.executionClass).toBeUndefined();
        } else {
          expect(order?.category?.id).toBe(operation === "change" ? "payments" : "wallet");
        }
        expect(mappings.items.find((item) => item.srNum === "SECOND")).toMatchObject({
          revision: operation === "assign" ? 1 : 0,
          ...(operation === "assign" ? { category: { id: "wallet" } } : {}),
        });
        const categories = await repository.listRequirementCategories(scope, {
          query: "",
          limit: 10,
        });
        expect(categories.items).toHaveLength(
          operation === "create" ? 3 : operation === "delete" ? 1 : 2,
        );
        expect(categories.items.find((item) => item.id === "wallet")).toMatchObject({
          name: operation === "edit" ? "Updated wallet" : "Wallet",
          revision: operation === "edit" ? 2 : 1,
        });
        expect(
          await repository.listExecutionClassRange(scope, { query: "", limit: 10 }),
        ).toMatchObject({
          revision: operation === "range" ? 2 : 1,
        });
      } finally {
        clearImmediate(release);
        if (writer.inTransaction) writer.exec("ROLLBACK");
        writer.close();
        handle.close();
      }
    },
  );

  it("bounds persistent contention, leaves the SR unchanged, and accepts a later save", async () => {
    const { handle, repository, scope, assignment } = await categoryFixture();
    const writer = new Database(handle.client.name);
    const change = { ...assignment, categoryId: "payments", expectedRevision: 1 };
    try {
      writer.exec("BEGIN IMMEDIATE");
      await expect(repository.setSrExecutionClass(change)).rejects.toMatchObject({
        code: "SQLITE_BUSY",
      });
      expect(handle.client.inTransaction).toBe(false);
      expect(
        await repository.listSrExecutionMappings(scope, { query: "ORDER", limit: 1 }),
      ).toMatchObject({
        items: [{ revision: 1, category: { id: "wallet" } }],
      });
      writer.exec("ROLLBACK");
      await repository.setSrExecutionClass(change);
      await expect(repository.setSrExecutionClass(change)).rejects.toMatchObject({
        code: "DDT_EXECUTION_MAPPING_REVISION_CONFLICT",
      });
      expect(
        await repository.listSrExecutionMappings(scope, { query: "ORDER", limit: 1 }),
      ).toMatchObject({
        items: [{ revision: 2, category: { id: "payments" } }],
      });
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      handle.close();
    }
  });

  it("rechecks SR revisions after contention instead of overwriting another user's change", async () => {
    const { handle, repository, scope, assignment } = await categoryFixture();
    const writer = new Database(handle.client.name);
    let release: ReturnType<typeof setImmediate> | undefined;
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare(
          "UPDATE ddt_sr_execution_mappings SET category_id = 'payments', revision = 2 WHERE sr_num_normalized = 'order'",
        )
        .run();
      release = setImmediate(() => writer.exec("COMMIT"));
      await expect(
        repository.setSrExecutionClass({ ...assignment, categoryId: null, expectedRevision: 1 }),
      ).rejects.toMatchObject({
        code: "DDT_EXECUTION_MAPPING_REVISION_CONFLICT",
      });
      expect(
        await repository.listSrExecutionMappings(scope, { query: "ORDER", limit: 1 }),
      ).toMatchObject({
        items: [{ revision: 2, category: { id: "payments" } }],
      });
    } finally {
      clearImmediate(release);
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      handle.close();
    }
  });

  it("rechecks category availability after another writer deletes the selected category", async () => {
    const { handle, repository, scope, assignment } = await categoryFixture();
    const writer = new Database(handle.client.name);
    let release: ReturnType<typeof setImmediate> | undefined;
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("DELETE FROM ddt_requirement_categories WHERE id = 'payments'").run();
      release = setImmediate(() => writer.exec("COMMIT"));
      await expect(
        repository.setSrExecutionClass({
          ...assignment,
          categoryId: "payments",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({
        code: "DDT_CATEGORY_NOT_FOUND",
      });
      expect(
        await repository.listSrExecutionMappings(scope, { query: "ORDER", limit: 1 }),
      ).toMatchObject({
        items: [{ revision: 1, category: { id: "wallet" } }],
      });
    } finally {
      clearImmediate(release);
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      handle.close();
    }
  });

  it("keeps import, history, templates and recycle lifecycle inside one project hierarchy", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ddt-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.db"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    const contention = new SqliteWriterContention(handle);
    const structures = contention.wrap(new SqliteProjectStructureRepository(handle));
    const repository = contention.wrap(new SqliteDdtRepository(handle));
    try {
      await structures.createVersion({
        id: "ddt-version",
        projectId: DEFAULT_PROJECT_ID,
        name: "1.1.0",
        normalizedName: "1.1.0",
        recordedAt: now,
      });
      await structures.createStage({
        id: "ddt-stage",
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId: "ddt-version",
        name: "系统测试",
        normalizedName: "系统测试",
        description: "",
        recordedAt: now,
      });
      const scope = {
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId: "ddt-version",
        testStageId: "ddt-stage",
      };
      const preview = await repository.createImportPreview({
        job: {
          ...scope,
          id: "ddt-job",
          status: "previewed",
          uploads: [
            {
              id: "upload-1",
              fileName: "订单.xlsx",
              objectKey: "ddt/default/job/upload",
              sha256: "a".repeat(64),
              sizeBytes: 128,
              mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          ],
          progressPercent: 0,
          totalFiles: 1,
          validFiles: 1,
          totalRows: 2,
          insertedCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          skippedCount: 0,
          failedFiles: 0,
          createdAt: now,
          updatedAt: now,
        },
        files: [
          {
            id: "ddt-file",
            uploadId: "upload-1",
            fileName: "订单.xlsx",
            rowCount: 2,
            insertedCount: 2,
            updatedCount: 0,
            unchangedCount: 0,
          },
        ],
      });
      expect(preview).toMatchObject({ status: "previewed", validFiles: 1, totalRows: 2 });
      const resolvedPreview = await repository.replaceImportPreview({
        jobId: "ddt-job",
        uploads: [
          {
            ...preview.uploads[0]!,
            columnResolutions: [
              {
                sheetName: "data",
                columnIndex: 3,
                resolvedName: "环境",
                deleteColumn: true,
              },
            ],
          },
        ],
        files: [
          {
            id: "ddt-file",
            uploadId: "upload-1",
            fileName: "订单.xlsx",
            rowCount: 2,
            insertedCount: 2,
            updatedCount: 0,
            unchangedCount: 0,
          },
        ],
        totalFiles: 1,
        validFiles: 1,
        totalRows: 2,
        failedFiles: 0,
        updatedAt: now,
        projectIds: [DEFAULT_PROJECT_ID],
      });
      expect(resolvedPreview).toMatchObject({
        uploads: [
          {
            columnResolutions: [
              {
                sheetName: "data",
                columnIndex: 3,
                resolvedName: "环境",
                deleteColumn: true,
              },
            ],
          },
        ],
        files: [{ id: "ddt-file", status: "valid" }],
      });

      const envelope: JobEnvelope = {
        messageId: "ddt-message",
        runId: "ddt-job",
        attempt: 1,
        schemaVersion: 1,
        kind: "ddt-import",
        payload: { jobId: "ddt-job" },
        priority: 0,
        deduplicationKey: "ddt-import:ddt-job",
        createdAt: now,
      };
      await repository.confirmImport({
        jobId: "ddt-job",
        conflictStrategy: "overwrite",
        dispatchJob: envelope,
        updatedAt: now,
        projectIds: [DEFAULT_PROJECT_ID],
      });
      await expect(repository.claimImportJob("ddt-job", now)).resolves.toMatchObject({
        status: "running",
      });
      const imported = await repository.importFile({
        jobId: "ddt-job",
        fileId: "ddt-file",
        scope,
        sourceName: "订单.xlsx",
        rows: [
          {
            id: "ddt-case-1",
            caseId: "ORDER-1",
            srNum: "ORDER",
            data: { CaseID: "ORDER-1", srNum: "ORDER", amount: 10 },
          },
          {
            id: "ddt-case-2",
            caseId: "ORDER-2",
            srNum: "ORDER",
            data: { CaseID: "ORDER-2", srNum: "ORDER", amount: 20, ...ddtLiteralSearchFields },
          },
        ],
        conflictStrategy: "overwrite",
        importedAt: now,
        historyIds: ["history-import-1", "history-import-2"],
      });
      expect(imported).toMatchObject({ insertedCount: 2, updatedCount: 0 });
      await expectDdtCaseSearch(repository, scope, "ORDER-2");
      insertExecutionClass(handle, scope);
      await expect(repository.listExecutionClasses(scope, "Order", 10)).resolves.toEqual([
        expect.objectContaining({
          caseDefinitionId: "ddt-execution-definition",
          className: "com.example.OrderDdtTest",
          displayName: "订单 DDT 执行类",
        }),
      ]);
      handle.client
        .prepare(
          `INSERT INTO case_definitions (id,project_id,project_version_id,test_stage_id,directory_path,source_id,class_name,package_name,display_name,description,tags_json,parameters_json,enabled,archived,revision,groups_json,current_version,created_at,updated_at) SELECT ?,project_id,project_version_id,test_stage_id,directory_path,source_id,'com.example.PaymentDdtTest',package_name,'支付执行类',description,tags_json,parameters_json,enabled,archived,revision,groups_json,current_version,created_at,updated_at FROM case_definitions WHERE id = ?`,
        )
        .run("ddt-execution-definition" + "-replacement", "ddt-execution-definition");
      await expectDdtSrExecutionContract(
        repository,
        scope,
        ["ORDER-1", "ORDER-2"],
        "ddt-execution-definition",
        now,
      );
      await expectDdtUnavailableSourceContract(
        repository,
        scope,
        "ddt-execution-definition",
        now,
        async (source) => {
          handle.client
            .prepare(
              "UPDATE case_sources SET project_id = ?, status = ?, lifecycle_status = ? WHERE id = ?",
            )
            .run(source.projectId, source.status, source.lifecycleStatus, "ddt-execution-source");
        },
      );
      insertDdtSuiteMembership(handle, "ddt-case-1");
      await expect(new SqliteCaseSuiteRepository(handle).get("ddt-suite")).resolves.toMatchObject({
        ddtItems: [
          { ddtCase: { executionClass: { caseDefinitionId: "ddt-execution-definition" } } },
        ],
      });
      await expect(
        repository.trashCases({
          scope,
          caseIds: ["ORDER-1"],
          recycleIds: ["recycle-blocked-order-1"],
          deletedAt: now,
        }),
      ).rejects.toMatchObject({ code: "DDT_CASE_IN_USE" });
      await expect(repository.getImportJob("ddt-job")).resolves.toMatchObject({
        files: [{ id: "ddt-file", status: "succeeded", insertedCount: 2 }],
      });
      await expect(
        repository.listCases({ ...scope, limit: 20, filters: [] }),
      ).resolves.toMatchObject({
        items: [
          {
            caseId: "ORDER-1",
            executionClass: { className: "com.example.OrderDdtTest" },
          },
          {
            caseId: "ORDER-2",
            executionClass: { className: "com.example.OrderDdtTest" },
          },
        ],
      });
      await expect(repository.dashboard(scope)).resolves.toMatchObject({
        caseCount: 2,
        groupCount: 1,
      });

      await repository.updateCases([
        {
          scope,
          caseId: "ORDER-1",
          expectedRevision: 1,
          nextData: { CaseID: "ORDER-1", srNum: "ORDER", amount: 15 },
          historyId: "history-edit",
          historyType: "edit",
          sourceName: "DDT 管理编辑",
          updatedAt: "2026-08-24T08:01:00.000Z",
        },
      ]);
      await expect(
        repository.listHistory({ ...scope, caseId: "ORDER-1", limit: 10 }),
      ).resolves.toMatchObject({
        items: [{ id: "history-edit", changes: [expect.objectContaining({ field: "amount" })] }],
      });
      await expect(
        repository.updateCases([
          {
            scope,
            caseId: "ORDER-1",
            expectedRevision: 2,
            nextData: { CaseID: "ORDER-2", srNum: "ORDER", amount: 15 },
            historyId: "history-conflict",
            historyType: "edit",
            sourceName: "DDT 管理编辑",
            updatedAt: "2026-08-24T08:02:00.000Z",
          },
        ]),
      ).rejects.toMatchObject({ code: "DDT_CASE_ID_CONFLICT" });

      await expect(
        repository.writeTemplate({
          ...scope,
          id: "template-order",
          srNum: "ORDER",
          name: "订单字段",
          description: "订单参数规则",
          rules: [{ field: "amount", required: true, type: "number" }],
          now,
        }),
      ).resolves.toMatchObject({ revision: 1, srNum: "ORDER" });

      await expect(
        repository.trashCases({
          scope,
          caseIds: ["ORDER-2"],
          recycleIds: ["recycle-order-2"],
          deletedAt: now,
        }),
      ).resolves.toBe(1);
      await expect(repository.listDeletedCases({ ...scope, limit: 10 })).resolves.toMatchObject({
        items: [{ id: "recycle-order-2", caseId: "ORDER-2" }],
      });
      await expect(
        repository.restoreDeletedCase({ scope, recycleId: "recycle-order-2", restoredAt: now }),
      ).resolves.toMatchObject({
        caseId: "ORDER-2",
        executionClass: { className: "com.example.OrderDdtTest" },
      });
      await expect(repository.listImportCaseIds("ddt-job", [DEFAULT_PROJECT_ID])).resolves.toEqual([
        { caseId: "ORDER-1", outcome: "inserted" },
        { caseId: "ORDER-2", outcome: "inserted" },
      ]);
    } finally {
      await contention.close();
      handle.close();
    }
  });
});

async function categoryFixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ddt-categories-"));
  temporaryDirectories.push(directory);
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.db"),
    migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    busyTimeoutMs: 25,
  });
  try {
    const structures = new SqliteProjectStructureRepository(handle);
    const scope = {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: "ddt-version",
      testStageId: "ddt-stage",
    };
    await structures.createVersion({
      id: scope.projectVersionId,
      projectId: scope.projectId,
      name: "DDT version",
      normalizedName: "ddt version",
      recordedAt: now,
    });
    await structures.createStage({
      id: scope.testStageId,
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      name: "DDT stage",
      normalizedName: "ddt stage",
      description: "",
      recordedAt: now,
    });
    insertExecutionClass(handle, scope);
    const repository = new SqliteDdtRepository(handle);
    const candidate = {
      scope,
      executionCaseDefinitionId: "ddt-execution-definition",
      included: true,
      expectedRevision: 0,
      updatedAt: now,
    };
    await repository.changeExecutionClassRange(candidate);
    const category = {
      scope,
      id: "wallet",
      name: "Wallet",
      executionCaseDefinitionId: candidate.executionCaseDefinitionId,
      expectedRevision: 0,
      updatedAt: now,
    };
    await repository.saveRequirementCategory(category);
    await repository.saveRequirementCategory({ ...category, id: "payments", name: "Payments" });
    for (const srNum of ["ORDER", "SECOND"]) {
      handle.client
        .prepare(
          `INSERT INTO ddt_cases (id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'standard','{}',?,?)`,
        )
        .run(
          srNum,
          scope.projectId,
          scope.projectVersionId,
          scope.testStageId,
          srNum,
          srNum.toLowerCase(),
          srNum,
          srNum.toLowerCase(),
          now,
          now,
        );
    }
    const assignment = {
      scope,
      srNum: "ORDER",
      executionCaseDefinitionId: null,
      categoryId: "wallet",
      expectedRevision: 0,
      updatedAt: now,
    };
    await repository.setSrExecutionClass(assignment);
    return { handle, repository, scope, category, assignment, candidate };
  } catch (error) {
    handle.close();
    throw error;
  }
}

function insertExecutionClass(
  handle: ReturnType<typeof createSqliteDatabase>,
  scope: { projectId: string; projectVersionId: string; testStageId: string },
): void {
  handle.client
    .prepare(
      `INSERT INTO case_sources
       (id, project_id, project_version_id, test_stage_id, display_name, original_file_name,
        object_key, sha256, size_bytes, class_count, method_count, status, warnings_json,
        inspection_json, authoritative, lifecycle_status, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 128, 1, 1, 'ready', '[]', '{}', 0, 'active', 1, ?, ?)`,
    )
    .run(
      "ddt-execution-source",
      scope.projectId,
      scope.projectVersionId,
      scope.testStageId,
      "DDT execution source",
      "ddt-execution.jar",
      "jars/ddt-execution.jar",
      "d".repeat(64),
      now,
      now,
    );
  handle.client
    .prepare(
      `INSERT INTO case_definitions
       (id, project_id, project_version_id, test_stage_id, directory_path, source_id,
        class_name, package_name, display_name, description, tags_json, parameters_json,
        enabled, archived, revision, groups_json, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'com/example', ?, ?, 'com.example', ?, '', '[]', '{}',
               1, 0, 1, '[]', 1, ?, ?)`,
    )
    .run(
      "ddt-execution-definition",
      scope.projectId,
      scope.projectVersionId,
      scope.testStageId,
      "ddt-execution-source",
      "com.example.OrderDdtTest",
      "订单 DDT 执行类",
      now,
      now,
    );
}

function insertDdtSuiteMembership(
  handle: ReturnType<typeof createSqliteDatabase>,
  ddtCaseId: string,
): void {
  handle.client
    .prepare(
      `INSERT INTO case_suites
       (id, project_id, name, version, status, enabled, revision, policy_json, created_at, updated_at)
       VALUES ('ddt-suite', ?, 'DDT suite', 1, 'active', 1, 1, '{}', ?, ?)`,
    )
    .run(DEFAULT_PROJECT_ID, now, now);
  handle.client
    .prepare(
      `INSERT INTO case_suite_ddt_items (id, suite_id, ddt_case_id, added_at)
       VALUES ('ddt-suite-item', 'ddt-suite', ?, ?)`,
    )
    .run(ddtCaseId, now);
}
