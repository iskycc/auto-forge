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
});

function upload(fileName: string) {
  return {
    fileName,
    mediaType: "text/csv",
    content: new TextEncoder().encode("CaseID,srNum\ncase,SR\n"),
  };
}
