import { describe, expect, it, vi } from "vitest";
import type { DdtCaseData } from "@autoforge/domain";
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
  it("counts cases once and indexes page boundaries across interrupted slices", async () => {
    const candidates = Array.from({ length: 47 }, (_, index) =>
      candidate(String(index).padStart(3, "0"), index % 2 ? "other" : "match match"),
    );
    const repository = {
      readValueSearchCandidates: vi.fn(async (_scope: unknown, cursor = "") =>
        candidates.filter((item) => item.cursor > cursor).slice(0, 13),
      ),
    };
    let cursor: string | undefined;
    let matchedCount = 0;
    let scannedCount = 0;
    const pageCursors: string[] = [];
    do {
      const page = await searchDdtValues(
        repository,
        { ...input, cursor, indexOffset: matchedCount % 20 },
        async () => "pause",
      );
      expect(page.items).toEqual([]);
      matchedCount += page.index!.matchedCount;
      scannedCount += page.scannedCount;
      pageCursors.push(...page.index!.pageCursors);
      cursor = page.nextCursor;
    } while (cursor);
    expect(matchedCount).toBe(24);
    expect(scannedCount).toBe(47);
    expect(pageCursors).toEqual(["", "039"]);
    const second = await searchDdtValues(
      repository,
      { ...input, limit: 20, cursor: pageCursors[1] },
      async () => "continue",
    );
    expect(second.items.map((item) => item.id)).toEqual(["040", "042", "044", "046"]);
  });

  it("does not create a phantom page for exact page multiples or empty searches", async () => {
    const candidates = Array.from({ length: 40 }, (_, index) =>
      candidate(String(index).padStart(3, "0"), "match"),
    );
    const repository = {
      readValueSearchCandidates: vi.fn(async (_scope: unknown, cursor = "") =>
        candidates.filter((item) => item.cursor > cursor),
      ),
    };
    const page = await searchDdtValues(
      repository,
      { ...input, indexOffset: 0 },
      async () => "continue",
    );
    expect(page.index).toEqual({ matchedCount: 40, pageCursors: ["", "019"] });
    expect(page.nextCursor).toBeUndefined();
    const empty = await searchDdtValues(
      repository,
      { ...input, keyword: "absent", indexOffset: 0 },
      async () => "continue",
    );
    expect(empty.index).toEqual({ matchedCount: 0, pageCursors: [] });
  });

  it.each<{ label: string; data: DdtCaseData; caseName: string | undefined }>([
    { label: "standard case", data: { CaseName: "余额查询" }, caseName: "余额查询" },
    {
      label: "journey's first numbered step",
      data: { 用户旅程: { step10: { CaseName: "最后一步" }, step2: { CaseName: "开通账户" } } },
      caseName: "开通账户",
    },
    { label: "missing name", data: {}, caseName: undefined },
    { label: "blank name", data: { CaseName: "  " }, caseName: undefined },
    { label: "null name", data: { CaseName: null }, caseName: undefined },
    { label: "numeric name", data: { CaseName: 0 }, caseName: "0" },
    {
      label: "large name",
      data: { CaseName: "长".repeat(2_000) },
      caseName: "长".repeat(1_023) + "…",
    },
  ])("includes the $label independently of matching fields", async ({ data, caseName }) => {
    const readValueSearchCandidates = vi
      .fn()
      .mockResolvedValue([{ ...candidate("a", "match"), data: { field: "match", ...data } }]);
    const result = await searchDdtValues(
      { readValueSearchCandidates },
      input,
      async () => "continue",
    );
    expect(result.items[0]?.caseName).toBe(caseName);
    expect(result.items[0]?.matches).toEqual([{ path: ["field"], value: "match" }]);
    expect(readValueSearchCandidates).toHaveBeenCalledTimes(1);
  });

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
