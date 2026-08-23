import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { PostgresDatabaseHandle, createPostgresDatabase } from "../src/postgres-database";
import { PostgresDdtRepository } from "../src/postgres-ddt";

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
          uploads: [],
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
              data: { CaseID: secondCaseId, srNum: "ORDER", amount: 99 },
            },
          ],
          conflictStrategy: "overwrite",
          importedAt: now,
          historyIds: [`history-import-${suffix}`, `history-import-second-${suffix}`],
        }),
      ).resolves.toMatchObject({ insertedCount: 2 });
      await expect(
        repository.listCases({
          ...scope,
          limit: 10,
          filters: [{ field: "amount", operator: "eq", value: 10 }],
        }),
      ).resolves.toMatchObject({ items: [{ caseId, srNum: "ORDER" }] });
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
      ).resolves.toMatchObject({ caseId });
    } finally {
      await handle.pool.query("DELETE FROM project_versions WHERE id = $1", [versionId]);
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
