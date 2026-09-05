import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

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
  it("keeps import, history, templates and recycle lifecycle inside one project hierarchy", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ddt-"));
    temporaryDirectories.push(directory);
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "autoforge.db"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    const structures = new SqliteProjectStructureRepository(handle);
    const repository = new SqliteDdtRepository(handle);
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
            data: { CaseID: "ORDER-2", srNum: "ORDER", amount: 20 },
          },
        ],
        conflictStrategy: "overwrite",
        importedAt: now,
        historyIds: ["history-import-1", "history-import-2"],
      });
      expect(imported).toMatchObject({ insertedCount: 2, updatedCount: 0 });
      insertExecutionClass(handle, scope);
      await expect(repository.listExecutionClasses(scope, "Order", 10)).resolves.toEqual([
        expect.objectContaining({
          caseDefinitionId: "ddt-execution-definition",
          className: "com.example.OrderDdtTest",
          displayName: "订单 DDT 执行类",
        }),
      ]);
      await expect(
        repository.setExecutionClass({
          scope,
          caseIds: ["ORDER-1", "ORDER-2"],
          executionCaseDefinitionId: "ddt-execution-definition",
          updatedAt: now,
        }),
      ).resolves.toBe(2);
      insertDdtSuiteMembership(handle, "ddt-case-1");
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
          expectedRevision: 2,
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
            expectedRevision: 3,
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
      handle.close();
    }
  });
});

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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 128, 1, 1, 'ready', '[]', '{}', 1, 'active', 1, ?, ?)`,
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
