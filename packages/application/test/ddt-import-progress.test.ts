import { describe, expect, it, vi } from "vitest";
import type { DdtImportFileSummary, DdtImportJobSummary } from "@autoforge/contracts";
import { DdtImportService, type DdtRepository, type JarObjectStorePort } from "../src";

const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
const now = "2026-10-19T00:00:00.000Z";
const job: DdtImportJobSummary = {
  ...scope,
  id: "job",
  status: "running",
  progressPercent: 1,
  totalFiles: 51,
  validFiles: 51,
  totalRows: 51,
  insertedCount: 0,
  updatedCount: 0,
  unchangedCount: 0,
  skippedCount: 0,
  failedFiles: 0,
  createdAt: now,
  updatedAt: now,
};
const files: DdtImportFileSummary[] = Array.from({ length: 51 }, (_, index) => ({
  id: `file-${String(index).padStart(3, "0")}`,
  fileName: `${index}.csv`,
  status: "pending",
  rowCount: 1,
  insertedCount: 0,
  updatedCount: 0,
  unchangedCount: 0,
  skippedCount: 0,
  createdAt: now,
  updatedAt: now,
}));
function fixture() {
  const reads = {
    getImportJob: vi.fn(() => {
      throw new Error("Full manifests must not be read");
    }),
    listImportJobs: vi.fn(() => {
      throw new Error("Full manifests must not be read");
    }),
    getImportJobSummary: vi.fn(async (): Promise<DdtImportJobSummary | null> => job),
    listImportJobSummaries: vi.fn(async () => ({ items: [job] })),
    listImportFiles: vi.fn(async (input: Parameters<DdtRepository["listImportFiles"]>[0]) =>
      files.filter((file) => !input.cursor || file.id > input.cursor.id).slice(0, input.limit),
    ),
  };
  const service = new DdtImportService(
    reads as unknown as DdtRepository,
    {} as JarObjectStorePort,
    {
      parseUpload: async () => {
        throw new Error("Progress reads must not parse spreadsheets");
      },
    },
    { now: () => new Date(now) },
    { next: () => "unused" },
  );
  return { service, reads };
}

describe("DDT import progress reads", () => {
  it("reads summaries without hydrating files or uploads", async () => {
    const { service, reads } = fixture();
    expect(await service.listSummaries(scope)).toEqual({ items: [job] });
    expect(reads.listImportJobSummaries).toHaveBeenCalledWith({ ...scope, limit: 50 });
    expect(reads.listImportFiles).not.toHaveBeenCalled();
    expect(reads.listImportJobs).not.toHaveBeenCalled();
  });

  it("returns bounded pages with a job-bound keyset cursor and retains the last file", async () => {
    const { service, reads } = fixture();
    const first = await service.files(scope, "job", {});
    expect(first.items).toHaveLength(50);
    expect(first.totalCount).toBe(51);
    const last = await service.files(scope, "job", { cursor: first.nextCursor! });
    expect(last.items.map((file) => file.id)).toEqual(["file-050"]);
    expect(last.nextCursor).toBeUndefined();
    expect(reads.listImportFiles).toHaveBeenLastCalledWith({
      ...scope,
      jobId: "job",
      cursor: { createdAt: now, id: "file-049" },
      limit: 51,
    });
    expect(reads.getImportJob).not.toHaveBeenCalled();
  });

  it.each([0, 101, -1, 1.5])(
    "rejects an invalid page size %s before database reads",
    async (limit) => {
      const { service, reads } = fixture();
      await expect(service.files(scope, "job", { limit })).rejects.toThrow();
      expect(reads.getImportJobSummary).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed and cross-job cursors before database reads", async () => {
    const { service, reads } = fixture();
    const first = await service.files(scope, "job", {});
    reads.getImportJobSummary.mockClear();
    for (const cursor of ["invalid", Buffer.from("{}").toString("base64url"), first.nextCursor!]) {
      await expect(service.files(scope, "other-job", { cursor })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    expect(reads.getImportJobSummary).not.toHaveBeenCalled();
  });

  it("does not query files when the scoped job is absent", async () => {
    const { service, reads } = fixture();
    reads.getImportJobSummary.mockResolvedValueOnce(null);
    await expect(service.files(scope, "missing", {})).rejects.toMatchObject({
      code: "DDT_IMPORT_NOT_FOUND",
    });
    expect(reads.listImportFiles).not.toHaveBeenCalled();
  });

  it("returns an empty page without a next cursor for an empty manifest", async () => {
    const { service, reads } = fixture();
    reads.getImportJobSummary.mockResolvedValueOnce({ ...job, totalFiles: 0 });
    reads.listImportFiles.mockResolvedValueOnce([]);
    expect(await service.files(scope, "job", {})).toEqual({ items: [], totalCount: 0 });
  });
});
