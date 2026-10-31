import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import {
  DdtImportService,
  type DdtRepository,
  type JarObjectStorePort,
  type ParsedDdtFile,
} from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-10-30T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !postgresUrl)(`${dialect} compact import`, () => {
    it("rolls back all cases and outcomes if a later deferred row cannot be decoded", async () => {
      await withRepository(dialect, async ({ repository, scope }) => {
        const jobId = randomUUID(),
          fileId = randomUUID();
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
              fileName: "wide.xlsx",
              rowCount: 2,
              insertedCount: 2,
              updatedCount: 0,
              unchangedCount: 0,
            },
          ],
        });
        let decodedFirst = false;
        await expect(
          repository.importFile({
            jobId,
            fileId,
            scope,
            sourceName: "wide.xlsx",
            conflictStrategy: "overwrite",
            importedAt: now,
            historyIds: [randomUUID(), randomUUID()],
            rows: [
              {
                id: randomUUID(),
                caseId: "a-case",
                srNum: "SR",
                readData: () => {
                  decodedFirst = true;
                  return { CaseID: "a-case", srNum: "SR", value: "原值" };
                },
              },
              {
                id: randomUUID(),
                caseId: "b-case",
                srNum: "SR",
                readData: () => {
                  throw new Error("decode failed");
                },
              },
            ],
          }),
        ).rejects.toThrow("decode failed");
        expect(decodedFirst).toBe(true);
        expect(await repository.getCase(scope, "a-case")).toBeNull();
        expect(await repository.getCase(scope, "b-case")).toBeNull();
        expect(await repository.listImportCaseIds(jobId)).toEqual([]);
      });
    });

    it("stores sparse fields and keeps journey steps, valid values and overwrite history", async () => {
      await withRepository(dialect, async ({ repository, scope }) => {
        const columns = Array.from({ length: 1024 }, (_, index) => `跨SR字段-${index}`);
        let parsed: ParsedDdtFile = {
          fileName: "export.xlsx",
          rowShape: {
            schemaVersion: 1,
            standard: ["CaseID", "srNum", "value", "nullable", "flag", "zero", ...columns],
            steps: {
              step1: ["CaseID", "srNum", "action", "empty"],
              step2: ["CaseID", "srNum", "result"],
            },
          },
          rows: [
            {
              CaseID: "中文普通",
              srNum: "SR",
              value: "原值",
              nullable: null,
              flag: false,
              zero: 0,
            },
            {
              CaseID: "中文旅程",
              srNum: "SR",
              用户旅程: { step1: { CaseID: "中文旅程", srNum: "SR", action: "执行" } },
            },
          ],
        };
        const storage = {
          putObject: async () => undefined,
          delete: async () => undefined,
          read: async () => Buffer.from("xlsx fixture"),
        } as unknown as JarObjectStorePort;
        const service = new DdtImportService(
          repository,
          storage,
          { parseUpload: async () => [parsed] },
          { now: () => new Date(now) },
          { next: randomUUID },
        );
        async function importFile() {
          const preview = await service.preview(scope, [
            {
              fileName: parsed.fileName,
              mediaType: "application/octet-stream",
              content: Buffer.from("fixture"),
            },
          ]);
          expect(preview.validFiles).toBe(1);
          await service.confirm(preview.id, "overwrite");
          await service.jobHandler()(
            {
              schemaVersion: 1,
              messageId: randomUUID(),
              runId: preview.id,
              attempt: 1,
              createdAt: now,
              priority: 0,
              deduplicationKey: randomUUID(),
              kind: "ddt-import",
              payload: { jobId: preview.id },
            },
            new AbortController().signal,
          );
          return repository.getImportJob(preview.id);
        }
        expect(await importFile()).toMatchObject({ status: "succeeded", insertedCount: 2 });
        expect((await repository.getCase(scope, "中文普通"))?.data).toEqual({
          CaseID: "中文普通",
          srNum: "SR",
          value: "原值",
          flag: false,
          zero: 0,
        });
        expect((await repository.getCase(scope, "中文旅程"))?.data).toEqual({
          CaseID: "中文旅程",
          srNum: "SR",
          用户旅程: { step1: { CaseID: "中文旅程", srNum: "SR", action: "执行" } },
        });
        parsed = { ...parsed, rows: [{ ...parsed.rows[0]!, value: "更新后" }, parsed.rows[1]!] };
        expect(await importFile()).toMatchObject({
          status: "succeeded",
          updatedCount: 1,
          unchangedCount: 1,
        });
        const history = await repository.listHistory({ ...scope, caseId: "中文普通", limit: 10 });
        expect(history.items.length).toBeGreaterThanOrEqual(1);
        const saved = await repository.getCase(scope, "中文普通");
        expect(saved?.data).toEqual({
          CaseID: "中文普通",
          srNum: "SR",
          value: "更新后",
          flag: false,
          zero: 0,
        });
        parsed = { ...parsed, rows: [{ ...parsed.rows[0]!, value: "" }, parsed.rows[1]!] };
        expect(await importFile()).toMatchObject({
          status: "succeeded",
          updatedCount: 1,
          unchangedCount: 1,
        });
        expect((await repository.getCase(scope, "中文普通"))?.data).toEqual({
          CaseID: "中文普通",
          srNum: "SR",
          flag: false,
          zero: 0,
        });
      });
    });
  });
}

async function withRepository(
  dialect: "sqlite" | "postgres",
  test: (harness: {
    repository: DdtRepository;
    scope: { projectId: string; projectVersionId: string; testStageId: string };
  }) => Promise<void>,
) {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-compact-repository-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "db.sqlite"),
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
        })
      : undefined;
  const postgres = sqlite
    ? undefined
    : createPostgresDatabase({
        connectionString: postgresUrl!,
        migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      });
  await postgres?.ready;
  const repository = sqlite
    ? new SqliteDdtRepository(sqlite)
    : new PostgresDdtRepository(postgres!);
  const structures = sqlite
    ? new SqliteProjectStructureRepository(sqlite)
    : new PostgresProjectStructureRepository(postgres!);
  const scope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: randomUUID(),
    testStageId: randomUUID(),
  };
  try {
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
      name: "stage",
      normalizedName: "stage",
      description: "",
      recordedAt: now,
    });
    await test({ repository, scope });
  } finally {
    sqlite?.close();
    if (postgres) await postgres.close();
    await rm(directory, { recursive: true, force: true });
  }
}
