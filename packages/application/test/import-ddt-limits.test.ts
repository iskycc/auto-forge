import { describe, expect, it, vi } from "vitest";

import {
  DdtImportService,
  type DdtImportLimits,
  type DdtRepository,
  type DdtSpreadsheetLimits,
  type JarObjectStorePort,
} from "../src";

const scope = {
  projectId: "project-1",
  projectVersionId: "version-1",
  testStageId: "stage-1",
};

describe("DDT import limits", () => {
  it("reads current upload and ZIP limits for every new preview", async () => {
    let limits: DdtImportLimits = {
      maximumUploadFiles: 1,
      maximumZipSpreadsheets: 7,
    };
    const observedSpreadsheetLimits: DdtSpreadsheetLimits[] = [];
    let sequence = 0;
    const repository = {
      listTemplates: vi.fn().mockResolvedValue([]),
      findCaseData: vi.fn().mockResolvedValue(new Map()),
      createImportPreview: vi.fn(async ({ job, files }) => ({ ...job, files })),
    } as unknown as DdtRepository;
    const objectStore = {
      putObject: vi.fn(async ({ objectKey }) => ({ objectKey, created: true })),
      delete: vi.fn().mockResolvedValue(undefined),
      storageKind: "local",
    } as unknown as JarObjectStorePort;
    const service = new DdtImportService(
      repository,
      objectStore,
      {
        parseUpload: vi.fn(async (upload, currentLimits) => {
          observedSpreadsheetLimits.push(currentLimits);
          return [{ fileName: upload.fileName, rows: [{ CaseID: upload.fileName, srNum: "SR" }] }];
        }),
      },
      { now: () => new Date("2026-09-08T00:00:00.000Z") },
      { next: () => `id-${++sequence}` },
      undefined,
      () => limits,
    );
    const uploads = [upload("a.csv"), upload("b.csv")];

    await expect(service.preview(scope, uploads)).rejects.toMatchObject({
      code: "DDT_FILE_LIMIT_EXCEEDED",
      message: "一次最多上传 1 个表格或 ZIP。",
    });

    limits = { maximumUploadFiles: 2, maximumZipSpreadsheets: 8 };
    await expect(service.preview(scope, uploads)).resolves.toMatchObject({
      totalFiles: 2,
      validFiles: 2,
    });
    expect(observedSpreadsheetLimits).toEqual([
      { maximumZipSpreadsheets: 8 },
      { maximumZipSpreadsheets: 8 },
    ]);
  });

  it("keeps valid and invalid ZIP entries while exposing resolvable column conflicts", async () => {
    let sequence = 0;
    const repository = {
      listTemplates: vi.fn(async () => []),
      findCaseData: vi.fn(async () => new Map()),
      createImportPreview: vi.fn(async ({ job, files }) => ({ ...job, files })),
    };
    const objectStore = {
      putObject: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const service = new DdtImportService(
      repository as unknown as DdtRepository,
      objectStore as unknown as JarObjectStorePort,
      {
        parseUpload: vi.fn(async () => [
          {
            fileName: "bundle.zip / valid.csv",
            archiveEntryName: "valid.csv",
            rows: [{ CaseID: "VALID", srNum: "CORE" }],
          },
          {
            fileName: "bundle.zip / conflict.csv",
            archiveEntryName: "conflict.csv",
            rows: [],
            errorSummary: "发现重复列名，请人工处理。",
            columnConflicts: [
              {
                archiveEntryName: "conflict.csv",
                sheetName: "Sheet1",
                normalizedName: "owner",
                columns: [
                  {
                    columnIndex: 2,
                    originalName: "owner",
                    currentName: "owner",
                    suggestedName: "owner",
                    nonEmptyCount: 1,
                    sampleValues: [{ rowNumber: 2, value: "alice" }],
                  },
                  {
                    columnIndex: 3,
                    originalName: "OWNER",
                    currentName: "OWNER",
                    suggestedName: "OWNER_2",
                    nonEmptyCount: 1,
                    sampleValues: [{ rowNumber: 2, value: "bob" }],
                  },
                ],
              },
            ],
          },
          {
            fileName: "bundle.zip / invalid.csv",
            archiveEntryName: "invalid.csv",
            rows: [],
            errorSummary: "缺少必需列 srNum",
          },
        ]),
      },
      { now: () => new Date("2026-09-08T00:00:00.000Z") },
      { next: () => `id-${++sequence}` },
    );

    const job = await service.preview(scope, [
      {
        fileName: "bundle.zip",
        mediaType: "application/zip",
        content: new Uint8Array([1, 2, 3]),
      },
    ]);

    expect(job).toMatchObject({ totalFiles: 3, validFiles: 1, failedFiles: 2, totalRows: 1 });
    expect(job.uploads[0]?.columnConflicts).toEqual([
      expect.objectContaining({ archiveEntryName: "conflict.csv", normalizedName: "owner" }),
    ]);
    expect(job.files.map((file) => [file.archiveEntryName, file.errorSummary])).toEqual([
      ["valid.csv", undefined],
      ["conflict.csv", "发现重复列名，请人工处理。"],
      ["invalid.csv", "缺少必需列 srNum"],
    ]);
  });
});

function upload(fileName: string) {
  return {
    fileName,
    mediaType: "text/csv",
    content: new TextEncoder().encode("CaseID,srNum\ncase,SR\n"),
  };
}
