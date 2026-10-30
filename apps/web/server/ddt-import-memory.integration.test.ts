import { describe, expect, it } from "vitest";
import {
  DdtImportService,
  type DdtRepository,
  type JarObjectStorePort,
  type ParsedDdtFile,
} from "@autoforge/application";
import {
  LARGE_DDT_FIELD_COUNT,
  LARGE_DDT_ROW_COUNT,
  largeDdtSpreadsheet,
  largeDdtValue,
  ddtSpreadsheetWithLargeNotesSheet,
} from "../../../packages/ddt-import/test/large-spreadsheet-fixture";
import { webResourcePlan } from "../src/lib/worker-sizing";
import { WorkerPool } from "./worker-pool";

describe("DDT import memory isolation", () => {
  it.each([
    { mode: "full", fieldCount: LARGE_DDT_FIELD_COUNT, richText: true, notes: false },
    { mode: "lite", fieldCount: LARGE_DDT_FIELD_COUNT, richText: true, notes: false },
    { mode: "full", fieldCount: 256, richText: false, notes: false },
    { mode: "lite", fieldCount: 256, richText: false, notes: false },
    { mode: "full", fieldCount: LARGE_DDT_FIELD_COUNT, richText: true, notes: true },
  ] as const)(
    "preflights an 8100-row $fieldCount-column workbook in $mode (notes=$notes) without dropping any field",
    async ({ mode, fieldCount, richText, notes }) => {
      const content = notes
        ? ddtSpreadsheetWithLargeNotesSheet()
        : largeDdtSpreadsheet({ fieldCount, richText });
      expect(content.byteLength).toBeLessThan(8 * 1024 ** 2);
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
        5_000,
        {
          ...webResourcePlan({ cpuCapacity: 4, memoryCapacityBytes: 4 * 1024 ** 3 }, mode),
          ...(notes ? { maintenanceWorkerHeapMb: 256 } : {}),
        },
      );
      try {
        let parsedFiles: ParsedDdtFile[] = [];
        let sequence = 0;
        const previews: Pick<
          DdtRepository,
          "listTemplates" | "findCaseData" | "createImportPreview"
        > = {
          listTemplates: async () => [],
          findCaseData: async () => new Map<string, ParsedDdtFile["rows"][number]>(),
          createImportPreview: async ({ job, files }) => ({
            ...job,
            files: files.map((file) => ({
              ...file,
              jobId: job.id,
              status: file.errorSummary ? "excluded" : "valid",
              skippedCount: 0,
              createdAt: job.createdAt,
              updatedAt: job.updatedAt,
            })),
          }),
        };
        const service = new DdtImportService(
          previews as DdtRepository,
          {
            putObject: async () => undefined,
            delete: async () => undefined,
          } as unknown as JarObjectStorePort,
          {
            parseUpload: async (upload, limits) => {
              parsedFiles = (await pool.parseFile("parse-ddt", {
                ...upload,
                parseLimits: limits,
              })) as ParsedDdtFile[];
              return parsedFiles;
            },
          },
          { now: () => new Date("2026-10-30T00:00:00.000Z") },
          { next: () => `preview-${++sequence}` },
        );
        const preview = await service.preview(
          {
            projectId: "project",
            projectVersionId: "version",
            testStageId: "stage",
          },
          [
            {
              fileName: "large.xlsx",
              mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              content,
            },
          ],
        );
        expect(preview.files[0]!.errorSummary).toBeUndefined();
        expect(preview).toMatchObject({
          validFiles: 1,
          failedFiles: 0,
          totalRows: LARGE_DDT_ROW_COUNT,
        });
        expect(preview.files[0]).toMatchObject({
          rowCount: LARGE_DDT_ROW_COUNT,
          insertedCount: LARGE_DDT_ROW_COUNT,
          updatedCount: 0,
          unchangedCount: 0,
        });
        expect(parsedFiles).toHaveLength(1);
        expect(parsedFiles[0]!.errorSummary).toBeUndefined();
        expect(parsedFiles[0]!.rows).toHaveLength(LARGE_DDT_ROW_COUNT);
        for (const [rowIndex, row] of parsedFiles[0]!.rows.entries()) {
          expect(Object.keys(row)).toHaveLength(fieldCount);
          for (let columnIndex = 0; columnIndex < fieldCount; columnIndex++) {
            const name =
              columnIndex === 0 ? "CaseID" : columnIndex === 1 ? "srNum" : `参数${columnIndex}`;
            expect(row[name]).toBe(largeDdtValue(rowIndex, columnIndex));
          }
        }
        await expect(
          pool.parseFile("parse-ddt", {
            fileName: "next.csv",
            mediaType: "text/csv",
            content: Buffer.from("CaseID,srNum\nnext,SR-NEXT\n"),
          }),
        ).resolves.toMatchObject([{ rows: [{ CaseID: "next", srNum: "SR-NEXT" }] }]);
      } finally {
        await pool.close();
      }
    },
    120_000,
  );
});
