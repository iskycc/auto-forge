import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { webResourcePlan } from "../src/lib/worker-sizing";
import { WorkerPool } from "./worker-pool";
import {
  DdtImportService,
  readDdtImportedRow,
  type DdtRepository,
  type DdtImportJob,
  type ParsedDdtFile,
  type JarObjectStorePort,
} from "@autoforge/application";

vi.mock("server-only", () => ({}));
import { prepareDdtExportFile } from "../src/lib/ddt-export-file";

it.each(["full", "lite"] as const)(
  "preflights a platform full export of 8100 cases with 1024 SR schemas in %s within its 12GiB thread budget",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-ddt-roundtrip-memory-"));
    const rowCount = 8100;
    const schemaCount = 1024;
    async function* pages() {
      for (let start = 0; start < rowCount; start += 64) {
        yield Array.from({ length: Math.min(64, rowCount - start) }, (_, offset) => {
          const index = start + offset;
          const schema = index % schemaCount;
          return {
            CaseID: `中文-${index}`,
            srNum: `SR-${schema}`,
            [`参数_${schema}`]: `原值-${index}`,
            [`结果_${schema}`]: index % 2 === 0,
          };
        });
      }
    }
    const plan = webResourcePlan(
      { cpuCapacity: 16, memoryCapacityBytes: 12 * 1024 ** 3 },
      mode,
      10,
    );
    const pool = new WorkerPool(
      {
        mode,
        dataDirectory: "unused",
        migrationsFolder: "unused",
        attemptLogsDirectory: "unused",
        caseExecutionTimeoutSeconds: 60,
        artifactCollectionEnabled: false,
        scheduler: {
          maximumCpuUtilizationPercent: 90,
          maximumMemoryUtilizationPercent: 90,
          maximumLoadPerCpu: 2,
          metricsMaximumAgeSeconds: 60,
          projectMaximumConcurrency: 500,
          priorityAgingIntervalMinutes: 1,
        },
      },
      1,
      5000,
      plan,
    );
    try {
      const prepared = await prepareDdtExportFile(pages(), new AbortController().signal, directory);
      let content: Buffer;
      try {
        content = Buffer.alloc(prepared.sizeBytes);
        await prepared.file.read(content, 0, content.length, 0);
      } finally {
        await prepared.file.close();
      }
      expect(content.byteLength).toBeLessThan(3 * 1024 ** 2);
      const files = (await pool.parseFile("parse-ddt", {
        fileName: "lite-full-export.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content,
        compactRows: true,
      })) as ParsedDdtFile[];
      expect(files[0]!.errorSummary).toBeUndefined();
      expect(files[0]!.rows).toHaveLength(rowCount);
      expect(files[0]!.rowShape?.standard).toHaveLength(schemaCount * 2 + 2);
      for (const [index, row] of files[0]!.rows.entries()) {
        expect(Object.keys(row)).toHaveLength(4);
        expect(row.CaseID).toBe(`中文-${index}`);
        expect(row[`参数_${index % schemaCount}`]).toBe(`原值-${index}`);
        expect(row[`结果_${index % schemaCount}`]).toBe(index % 2 === 0 ? "TRUE" : "FALSE");
      }
      if (mode === "full") await verifyImportPipeline(files, content);
    } finally {
      await pool.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  240_000,
);

async function verifyImportPipeline(files: ParsedDdtFile[], content: Buffer) {
  let job: DdtImportJob;
  let importedCount = 0;
  let sequence = 0;
  const source = files[0]!;
  const repository = {
    listTemplates: async () => [],
    findCaseData: async (_scope: unknown, ids: string[]) => {
      expect(ids.length).toBeLessThanOrEqual(64);
      return new Map();
    },
    createImportPreview: async ({
      job: current,
      files: previewFiles,
    }: Parameters<DdtRepository["createImportPreview"]>[0]) => {
      job = {
        ...current,
        files: previewFiles.map((file) => ({
          ...file,
          jobId: current.id,
          status: "valid",
          skippedCount: 0,
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
        })),
      };
      return job;
    },
    claimImportJob: async () => ({ ...job!, status: "running", conflictStrategy: "overwrite" }),
    getImportJob: async () => job!,
    updateImportFile: async () => undefined,
    updateImportJob: async () => undefined,
    importFile: async ({ rows }: Parameters<DdtRepository["importFile"]>[0]) => {
      const caseIds: Array<{ caseId: string; outcome: "inserted" }> = [];
      for (const [index, row] of rows.entries()) {
        expect("readData" in row).toBe(true);
        const cells = readDdtImportedRow(row);
        if (Object.keys(cells).length !== 4)
          throw new Error(`Blank columns expanded in ${row.caseId}`);
        const original = source.rows[index]!;
        for (const column of Object.keys(original)) {
          if (cells[column] !== original[column])
            throw new Error(`Changed ${row.caseId}/${column}`);
        }
        caseIds.push({ caseId: row.caseId, outcome: "inserted" });
        importedCount++;
      }
      return {
        insertedCount: rows.length,
        updatedCount: 0,
        unchangedCount: 0,
        skippedCount: 0,
        caseIds,
      };
    },
  } as unknown as DdtRepository;
  const service = new DdtImportService(
    repository,
    {
      putObject: async () => undefined,
      delete: async () => undefined,
      read: async () => content,
    } as unknown as JarObjectStorePort,
    { parseUpload: async () => files },
    { now: () => new Date("2026-10-30T00:00:00Z") },
    { next: () => `roundtrip-${++sequence}` },
  );
  const preview = await service.preview(
    { projectId: "project", projectVersionId: "version", testStageId: "stage" },
    [{ fileName: "lite-full-export.xlsx", mediaType: "application/octet-stream", content }],
  );
  expect(preview).toMatchObject({ validFiles: 1, totalRows: source.rows.length, failedFiles: 0 });
  await service.jobHandler()(
    {
      schemaVersion: 1,
      messageId: "import",
      runId: preview.id,
      attempt: 1,
      createdAt: preview.createdAt,
      priority: 0,
      deduplicationKey: "import",
      kind: "ddt-import",
      payload: { jobId: preview.id },
    },
    new AbortController().signal,
  );
  expect(importedCount).toBe(source.rows.length);
}
