import { describe, expect, it, vi } from "vitest";
import { DdtSrTagImportService } from "./import-ddt-sr-tags";
import { normalizeDdtSrTagKey } from "@autoforge/domain";
const scope = { projectId: "project", projectVersionId: "version" };
const row = (index: number) => ({
  sheetName: "分类",
  rowNumber: index + 2,
  srNum: `SR-${index}`,
  tagName: "Wallet",
});
function fixture(count = 2) {
  const parsed = {
    rows: Array.from({ length: count }, (_, index) => row(index)),
    rowCount: count,
    issueCount: 0,
    issues: [],
  };
  const repository = {
    findSrKeys: vi.fn(async (_scope: unknown, names: string[]) => names.map(normalizeDdtSrTagKey)),
    importPage: vi.fn(async (_scope: unknown, rows: unknown[]) => rows.length),
    classifications: vi.fn(async () => ({ items: [] })),
  };
  let id = 0;
  const service = new DdtSrTagImportService(
    repository,
    { parse: async () => parsed },
    { now: () => new Date("2026-10-24T00:00:00Z") },
    { next: () => `tag-${++id}` },
  );
  return { service, repository, parsed };
}
describe("SR tag bulk import", () => {
  it("reports missing SRs with source locations and writes nothing while validation has issues", async () => {
    const f = fixture();
    f.repository.findSrKeys.mockResolvedValueOnce(["sr-0"]);
    const inspected = await f.service.read(
      scope,
      { fileName: "labels.xlsx", content: new Uint8Array() },
      new AbortController().signal,
    );
    expect(inspected.preview.issues).toMatchObject([{ rowNumber: 3, srNum: "SR-1" }]);
    await expect(
      f.service.apply(scope, inspected.parsed, inspected.preview, new AbortController().signal),
    ).rejects.toMatchObject({ code: "SR_TAG_IMPORT_INVALID" });
    expect(f.repository.importPage).not.toHaveBeenCalled();
  });
  it("saves bounded pages and reports already-present associations separately", async () => {
    const f = fixture(101);
    f.repository.importPage.mockResolvedValueOnce(80).mockResolvedValueOnce(1);
    const inspected = await f.service.read(
      scope,
      { fileName: "labels.xlsx", content: new Uint8Array() },
      new AbortController().signal,
    );
    expect(
      await f.service.apply(
        scope,
        inspected.parsed,
        inspected.preview,
        new AbortController().signal,
      ),
    ).toEqual({ rowCount: 101, createdCount: 81, existingCount: 20 });
    expect(f.repository.importPage.mock.calls.map((call) => call[1].length)).toEqual([100, 1]);
  });
  it("preserves failure context and reports committed progress so interrupted imports can be retried", async () => {
    const f = fixture(101);
    const cause = new Error("injected database failure");
    f.repository.importPage.mockResolvedValueOnce(100).mockRejectedValueOnce(cause);
    const inspected = await f.service.read(
      scope,
      { fileName: "labels.xlsx", content: new Uint8Array() },
      new AbortController().signal,
    );
    await expect(
      f.service.apply(scope, inspected.parsed, inspected.preview, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "SR_TAG_IMPORT_INTERRUPTED",
      cause,
      details: { completedCount: 100, createdCount: 100 },
    });
  });
});
