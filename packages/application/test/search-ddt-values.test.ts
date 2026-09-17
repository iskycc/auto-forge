import { describe, expect, it, vi } from "vitest";
import { searchDdtValues } from "../src/search-ddt-values";

const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
const input = { ...scope, keyword: "match", limit: 1 };
const candidate = (id: string, value: string) => ({
  id,
  caseId: id,
  srNum: "SR",
  cursor: id,
  data: { field: value },
});

describe("bounded DDT value search", () => {
  it("resumes immediately after the last examined case, without losing remaining candidates", async () => {
    const readValueSearchCandidates = vi
      .fn()
      .mockResolvedValue([
        candidate("a", "other"),
        candidate("b", "match"),
        candidate("c", "match"),
      ]);
    const result = await searchDdtValues(
      { readValueSearchCandidates },
      input,
      async () => "continue",
    );
    expect(result).toMatchObject({ scannedCount: 2, nextCursor: "b", items: [{ caseId: "b" }] });
    expect(readValueSearchCandidates).toHaveBeenCalledExactlyOnceWith(input, undefined);
  });
  it("returns progress and a resumable cursor when the worker yields to higher priority work", async () => {
    const readValueSearchCandidates = vi.fn().mockResolvedValue([candidate("a", "other")]);
    expect(
      await searchDdtValues({ readValueSearchCandidates }, input, async () => "pause"),
    ).toEqual({ items: [], scannedCount: 1, nextCursor: "a" });
    readValueSearchCandidates.mockResolvedValue([]);
    expect(
      await searchDdtValues(
        { readValueSearchCandidates },
        { ...input, cursor: "a" },
        async () => "continue",
      ),
    ).toEqual({ items: [], scannedCount: 0 });
  });
  it("bounds each slice and stops cancelled reads", async () => {
    const readValueSearchCandidates = vi.fn().mockResolvedValue([candidate("a", "other")]);
    await searchDdtValues({ readValueSearchCandidates }, input, async () => "continue");
    expect(readValueSearchCandidates).toHaveBeenCalledTimes(16);
    const controller = new AbortController();
    controller.abort();
    readValueSearchCandidates.mockClear();
    await expect(
      searchDdtValues(
        { readValueSearchCandidates },
        input,
        async () => "continue",
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(readValueSearchCandidates).not.toHaveBeenCalled();
  });
});
