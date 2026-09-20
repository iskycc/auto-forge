import {
  expectDdtSrExecutionContract,
  expectDdtUnavailableSourceContract,
} from "./ddt-sr-execution-contract";
import { ddtLiteralSearchFields, expectDdtCaseSearch } from "./ddt-search-contract";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { PostgresDatabaseHandle, createPostgresDatabase } from "../src/postgres-database";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-08-24T08:00:00.000Z";

describe.skipIf(!connectionString)("PostgreSQL DDT repository", () => {
  it("matches Lite semantics for scoped import, update and recycle", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    await handle.ready;
    const suffix = randomUUID();
    const versionId = `ddt-version-${suffix}`;
    const stageId = `ddt-stage-${suffix}`;
    const jobId = `ddt-job-${suffix}`;
    const fileId = `ddt-file-${suffix}`;
    const caseId = `ORDER-${suffix}`;
    const secondCaseId = `ORDER-SECOND-${suffix}`;
    const scope = {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: versionId,
      testStageId: stageId,
    };
    const repository = new PostgresDdtRepository(handle);
    try {
      await createHierarchy(handle, versionId, stageId);
      await repository.createImportPreview({
        job: {
          ...scope,
          id: jobId,
          status: "previewed",
          uploads: [
            {
              id: `upload-${suffix}`,
              fileName: "data.xlsx",
              objectKey: `ddt/${suffix}/data.xlsx`,
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
            id: fileId,
            uploadId: "upload",
            fileName: "data.xlsx",
            rowCount: 2,
            insertedCount: 2,
            updatedCount: 0,
            unchangedCount: 0,
          },
        ],
      });
      await expect(
        repository.replaceImportPreview({
          jobId,
          uploads: [
            {
              id: `upload-${suffix}`,
              fileName: "data.xlsx",
              objectKey: `ddt/${suffix}/data.xlsx`,
              sha256: "a".repeat(64),
              sizeBytes: 128,
              mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
              id: fileId,
              uploadId: `upload-${suffix}`,
              fileName: "data.xlsx",
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
        }),
      ).resolves.toMatchObject({
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
        files: [{ id: fileId, status: "valid" }],
      });
      await expect(
        repository.importFile({
          jobId,
          fileId,
          scope,
          sourceName: "data.xlsx",
          rows: [
            {
              id: `case-${suffix}`,
              caseId,
              srNum: "ORDER",
              data: { CaseID: caseId, srNum: "ORDER", amount: 10 },
            },
            {
              id: `case-second-${suffix}`,
              caseId: secondCaseId,
              srNum: "ORDER",
              data: { CaseID: secondCaseId, srNum: "ORDER", amount: 99, ...ddtLiteralSearchFields },
            },
          ],
          conflictStrategy: "overwrite",
          importedAt: now,
          historyIds: [`history-import-${suffix}`, `history-import-second-${suffix}`],
        }),
      ).resolves.toMatchObject({ insertedCount: 2 });
      await expectDdtCaseSearch(repository, scope, secondCaseId);
      const executionDefinitionId = `ddt-execution-definition-${suffix}`;
      await insertExecutionClass(handle, scope, suffix, executionDefinitionId);
      await expect(repository.listExecutionClasses(scope, "Order", 10)).resolves.toEqual([
        expect.objectContaining({
          caseDefinitionId: executionDefinitionId,
          className: "com.example.OrderDdtTest",
          displayName: "订单 DDT 执行类",
        }),
      ]);
      await handle.pool.query(
        `INSERT INTO case_definitions (id,project_id,project_version_id,test_stage_id,directory_path,source_id,class_name,package_name,display_name,description,tags_json,parameters_json,enabled,archived,revision,groups_json,current_version,created_at,updated_at) SELECT $1,project_id,project_version_id,test_stage_id,directory_path,source_id,'com.example.PaymentDdtTest',package_name,'支付执行类',description,tags_json,parameters_json,enabled,archived,revision,groups_json,current_version,created_at,updated_at FROM case_definitions WHERE id = $2`,
        [executionDefinitionId + "-replacement", executionDefinitionId],
      );
      await expectDdtSrExecutionContract(
        repository,
        scope,
        [caseId, secondCaseId],
        executionDefinitionId,
        now,
      );
      await expectDdtUnavailableSourceContract(
        repository,
        scope,
        executionDefinitionId,
        now,
        async (source) => {
          await handle.pool.query(
            "UPDATE case_sources SET project_id = $1, status = $2, lifecycle_status = $3 WHERE id = $4",
            [
              source.projectId,
              source.status,
              source.lifecycleStatus,
              `ddt-execution-source-${suffix}`,
            ],
          );
        },
      );
      await insertDdtSuiteMembership(handle, suffix, `case-second-${suffix}`);
      await expect(
        new PostgresCaseSuiteRepository(handle).get(`ddt-suite-${suffix}`),
      ).resolves.toMatchObject({
        ddtItems: [{ ddtCase: { executionClass: { caseDefinitionId: executionDefinitionId } } }],
      });
      await expect(
        new PostgresCaseSuiteRepository(handle).listExportRowsPage({
          suiteId: `ddt-suite-${suffix}`,
          memberType: "ddt",
          limit: 10,
          projectIds: [DEFAULT_PROJECT_ID],
        }),
      ).resolves.toEqual([
        {
          memberId: `ddt-suite-item-${suffix}`,
          casePath: "com.example.OrderDdtTest",
          displayName: secondCaseId,
        },
      ]);
      await expect(
        repository.trashCases({
          scope,
          caseIds: [secondCaseId],
          recycleIds: [`recycle-blocked-${suffix}`],
          deletedAt: now,
        }),
      ).rejects.toMatchObject({ code: "DDT_CASE_IN_USE" });
      await expect(
        repository.listCases({
          ...scope,
          limit: 10,
          filters: [{ field: "amount", operator: "eq", value: 10 }],
        }),
      ).resolves.toMatchObject({
        items: [
          {
            caseId,
            srNum: "ORDER",
            executionClass: { className: "com.example.OrderDdtTest" },
          },
        ],
      });
      await repository.updateCases([
        {
          scope,
          caseId,
          expectedRevision: 1,
          nextData: { CaseID: caseId, srNum: "ORDER", amount: 20 },
          historyId: `history-${suffix}`,
          historyType: "edit",
          sourceName: "DDT 管理编辑",
          updatedAt: "2026-08-24T08:01:00.000Z",
        },
      ]);
      await expect(repository.listHistory({ ...scope, caseId, limit: 10 })).resolves.toMatchObject({
        items: [{ changes: [expect.objectContaining({ field: "amount" })] }],
      });
      await expect(
        repository.updateCases([
          {
            scope,
            caseId,
            expectedRevision: 2,
            nextData: { CaseID: secondCaseId, srNum: "ORDER", amount: 20 },
            historyId: `history-conflict-${suffix}`,
            historyType: "edit",
            sourceName: "DDT 管理编辑",
            updatedAt: "2026-08-24T08:02:00.000Z",
          },
        ]),
      ).rejects.toMatchObject({ code: "DDT_CASE_ID_CONFLICT" });
      await expect(
        repository.trashCases({
          scope,
          caseIds: [caseId],
          recycleIds: [`recycle-${suffix}`],
          deletedAt: now,
        }),
      ).resolves.toBe(1);
      await expect(
        repository.restoreDeletedCase({ scope, recycleId: `recycle-${suffix}`, restoredAt: now }),
      ).resolves.toMatchObject({
        caseId,
        executionClass: { className: "com.example.OrderDdtTest" },
      });
    } finally {
      await handle.pool.query("DELETE FROM case_suites WHERE id = $1", [`ddt-suite-${suffix}`]);
      await handle.pool.query("DELETE FROM case_sources WHERE project_version_id = $1", [
        versionId,
      ]);
      await handle.pool.query("DELETE FROM project_versions WHERE id = $1", [versionId]);
      await handle.close();
    }
  });
  it("imports unrelated cases in the same scope while another file transaction is held", async () => {
    const options = {
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    };
    const handle = createPostgresDatabase({ ...options, lockTimeoutMs: 10_000 });
    const concurrentHandle = createPostgresDatabase({ ...options, lockTimeoutMs: 10 });
    await Promise.all([handle.ready, concurrentHandle.ready]);
    const suffix = randomUUID();
    const scope = {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: `independent-${suffix}`,
      testStageId: `stage-${suffix}`,
    };
    const repository = new PostgresDdtRepository(handle);
    const jobId = `job-${suffix}`;
    const files = [0, 1].map((index) => ({
      id: `file-${index}-${suffix}`,
      uploadId: `upload-${index}`,
      fileName: `${index}.csv`,
      rowCount: 1,
      insertedCount: 1,
      updatedCount: 0,
      unchangedCount: 0,
    }));
    const blocker = await handle.pool.connect();
    let firstImport: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await createHierarchy(handle, scope.projectVersionId, scope.testStageId);
      await repository.createImportPreview({
        job: {
          ...scope,
          id: jobId,
          status: "previewed",
          uploads: [],
          progressPercent: 0,
          totalFiles: 2,
          validFiles: 2,
          totalRows: 2,
          insertedCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          skippedCount: 0,
          failedFiles: 0,
          createdAt: now,
          updatedAt: now,
        },
        files,
      });
      const importInput = (index: number) => ({
        scope,
        jobId,
        fileId: files[index]!.id,
        sourceName: files[index]!.fileName,
        importedAt: now,
        conflictStrategy: "overwrite" as const,
        rows: [
          {
            id: `case-${index}-${suffix}`,
            caseId: `CASE-${index}`,
            srNum: "SR",
            data: { CaseID: `CASE-${index}`, srNum: "SR" },
          },
        ],
        historyIds: [`history-${index}-${suffix}`],
      });
      await blocker.query("BEGIN");
      const locked = await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid FROM ddt_import_files WHERE id=$1 FOR UPDATE",
        [files[0]!.id],
      );
      firstImport = Promise.allSettled([repository.importFile(importInput(0))]);
      await expect
        .poll(async () => {
          const result = await handle.pool.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting",
            [locked.rows[0]!.pid],
          );
          return result.rows[0]!.waiting;
        })
        .toBe(true);
      await expect(
        new PostgresDdtRepository(concurrentHandle).importFile(importInput(1)),
      ).resolves.toMatchObject({ insertedCount: 1 });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      const results = await firstImport;
      await handle.pool.query("DELETE FROM project_versions WHERE id=$1", [scope.projectVersionId]);
      await Promise.all([handle.close(), concurrentHandle.close()]);
      if (results) expect(results[0]).toMatchObject({ status: "fulfilled" });
    }
  });

  it("serializes opposite-order imports and keeps concurrent edits atomic", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    await handle.ready;
    const suffix = randomUUID();
    const scope = {
      projectId: DEFAULT_PROJECT_ID,
      projectVersionId: `concurrent-${suffix}`,
      testStageId: `stage-${suffix}`,
    };
    const jobId = `job-${suffix}`;
    const repository = new PostgresDdtRepository(handle);
    const files = [0, 1].map((index) => ({
      id: `file-${index}-${suffix}`,
      uploadId: `upload-${index}`,
      fileName: `${index}.xlsx`,
      rowCount: 20,
      insertedCount: 20,
      updatedCount: 0,
      unchangedCount: 0,
    }));
    const caseIds = Array.from(
      { length: 20 },
      (_, index) => `CASE-${String(index).padStart(2, "0")}`,
    );
    try {
      await createHierarchy(handle, scope.projectVersionId, scope.testStageId);
      await repository.createImportPreview({
        job: {
          ...scope,
          id: jobId,
          status: "previewed",
          uploads: [],
          progressPercent: 0,
          totalFiles: 2,
          validFiles: 2,
          totalRows: 40,
          insertedCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          skippedCount: 0,
          failedFiles: 0,
          createdAt: now,
          updatedAt: now,
        },
        files,
      });
      const imports = await Promise.all(
        files.map((file, index) =>
          repository.importFile({
            scope,
            jobId,
            fileId: file.id,
            sourceName: file.fileName,
            importedAt: now,
            conflictStrategy: "overwrite",
            rows: (index === 0 ? caseIds : [...caseIds].reverse()).map((caseId) => ({
              id: `case-${index}-${caseId}-${suffix}`,
              caseId,
              srNum: "SR",
              data: { CaseID: caseId, srNum: "SR", value: "original" },
            })),
            historyIds: caseIds.map((caseId) => `import-${index}-${caseId}-${suffix}`),
          }),
        ),
      );
      expect(imports.reduce((sum, result) => sum + result.insertedCount, 0)).toBe(20);
      expect(imports.reduce((sum, result) => sum + result.unchangedCount, 0)).toBe(20);
      expect(imports[0]!.caseIds.map((item) => item.caseId)).toEqual(caseIds);
      expect(imports[1]!.caseIds.map((item) => item.caseId)).toEqual([...caseIds].reverse());
      const edits = await Promise.allSettled(
        [0, 1].map((index) =>
          repository.updateCases(
            (index === 0 ? caseIds : [...caseIds].reverse()).map((caseId) => ({
              scope,
              caseId,
              expectedRevision: 1,
              nextData: { CaseID: caseId, srNum: "SR", value: `editor-${index}` },
              historyId: `edit-${index}-${caseId}-${suffix}`,
              historyType: "edit",
              sourceName: "DDT edit",
              updatedAt: now,
            })),
          ),
        ),
      );
      expect(edits.filter((edit) => edit.status === "fulfilled")).toHaveLength(1);
      expect(edits.find((edit) => edit.status === "rejected")).toMatchObject({
        status: "rejected",
        reason: { code: "DDT_CASE_REVISION_CONFLICT" },
      });
      const cases = await repository.getCases(scope, caseIds);
      expect(cases).toHaveLength(20);
      expect(cases.every((item) => item.revision === 2)).toBe(true);
      expect(new Set(cases.map((item) => item.data.value)).size).toBe(1);
      const history = await handle.pool.query<{ count: string }>(
        "SELECT count(*) FROM ddt_case_history WHERE ddt_case_id IN (SELECT id FROM ddt_cases WHERE project_version_id=$1)",
        [scope.projectVersionId],
      );
      expect(Number(history.rows[0]!.count)).toBe(20);
      // Grouping lock acquisition must not change duplicate-key overwrite order or history IDs.
      const duplicateKeys = [caseIds[1]!, caseIds[0]!, caseIds[1]!.toLowerCase()];
      const repeated = await repository.importFile({
        scope,
        jobId,
        fileId: files[0]!.id,
        sourceName: files[0]!.fileName,
        importedAt: now,
        conflictStrategy: "overwrite",
        rows: duplicateKeys.map((caseId, index) => ({
          id: `duplicate-${index}-${suffix}`,
          caseId,
          srNum: "SR",
          data: { CaseID: caseId, srNum: "SR", value: `duplicate-${index}` },
        })),
        historyIds: duplicateKeys.map((_, index) => `duplicate-history-${index}-${suffix}`),
      });
      expect(repeated.updatedCount).toBe(3);
      expect(repeated.caseIds.map((item) => item.caseId)).toEqual(duplicateKeys);
      expect((await repository.getCases(scope, [caseIds[1]!]))[0]?.data.value).toBe("duplicate-2");
      const duplicateHistory = await handle.pool.query<{ id: string; after_json: string }>(
        "SELECT id,after_json FROM ddt_case_history WHERE id=ANY($1::text[]) ORDER BY id",
        [duplicateKeys.map((_, index) => `duplicate-history-${index}-${suffix}`)],
      );
      expect(duplicateHistory.rows.map((row) => JSON.parse(row.after_json).value)).toEqual([
        "duplicate-0",
        "duplicate-1",
        "duplicate-2",
      ]);
      await expect(
        repository.importFile({
          scope,
          jobId,
          fileId: files[0]!.id,
          sourceName: files[0]!.fileName,
          importedAt: now,
          conflictStrategy: "error",
          rows: ["AAA-new", caseIds[0]!].map((caseId, index) => ({
            id: `rollback-${index}-${suffix}`,
            caseId,
            srNum: "SR",
            data: { CaseID: caseId, srNum: "SR", value: "must roll back" },
          })),
          historyIds: [0, 1].map((index) => `rollback-history-${index}-${suffix}`),
        }),
      ).rejects.toMatchObject({ code: "DDT_IMPORT_CONFLICT" });
      expect(await repository.getCases(scope, ["AAA-new"])).toEqual([]);
    } finally {
      await handle.pool.query("DELETE FROM project_versions WHERE id=$1", [scope.projectVersionId]);
      await handle.close();
    }
  });
});

async function createHierarchy(handle: PostgresDatabaseHandle, versionId: string, stageId: string) {
  await handle.pool.query(
    `INSERT INTO project_versions(id, project_id, name, normalized_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $4, $4)`,
    [versionId, DEFAULT_PROJECT_ID, versionId, now],
  );
  await handle.pool.query(
    `INSERT INTO test_stages(id, project_id, project_version_id, name, normalized_name,
     description, position, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '', 1, $5, $5)`,
    [stageId, DEFAULT_PROJECT_ID, versionId, stageId, now],
  );
}

async function insertExecutionClass(
  handle: PostgresDatabaseHandle,
  scope: { projectId: string; projectVersionId: string; testStageId: string },
  suffix: string,
  definitionId: string,
): Promise<void> {
  const sourceId = `ddt-execution-source-${suffix}`;
  await handle.pool.query(
    `INSERT INTO case_sources
     (id, project_id, project_version_id, test_stage_id, display_name, original_file_name,
      object_key, sha256, size_bytes, class_count, method_count, status, warnings_json,
      inspection_json, authoritative, lifecycle_status, revision, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 128, 1, 1, 'ready', '[]', '{}',
             FALSE, 'active', 1, $9, $9)`,
    [
      sourceId,
      scope.projectId,
      scope.projectVersionId,
      scope.testStageId,
      "DDT execution source",
      "ddt-execution.jar",
      `jars/${suffix}/ddt-execution.jar`,
      "d".repeat(64),
      now,
    ],
  );
  await handle.pool.query(
    `INSERT INTO case_definitions
     (id, project_id, project_version_id, test_stage_id, directory_path, source_id,
      class_name, package_name, display_name, description, tags_json, parameters_json,
      enabled, archived, revision, groups_json, current_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'com/example', $5, $6, 'com.example', $7, '', '[]', '{}',
             TRUE, FALSE, 1, '[]', 1, $8, $8)`,
    [
      definitionId,
      scope.projectId,
      scope.projectVersionId,
      scope.testStageId,
      sourceId,
      "com.example.OrderDdtTest",
      "订单 DDT 执行类",
      now,
    ],
  );
}

async function insertDdtSuiteMembership(
  handle: PostgresDatabaseHandle,
  suffix: string,
  ddtCaseId: string,
): Promise<void> {
  const suiteId = `ddt-suite-${suffix}`;
  await handle.pool.query(
    `INSERT INTO case_suites
     (id, project_id, name, version, status, enabled, revision, policy_json, created_at, updated_at)
     VALUES ($1, $2, 'DDT suite', 1, 'active', TRUE, 1, '{}', $3, $3)`,
    [suiteId, DEFAULT_PROJECT_ID, now],
  );
  await handle.pool.query(
    `INSERT INTO case_suite_ddt_items (id, suite_id, ddt_case_id, added_at)
     VALUES ($1, $2, $3, $4)`,
    [`ddt-suite-item-${suffix}`, suiteId, ddtCaseId, now],
  );
}
