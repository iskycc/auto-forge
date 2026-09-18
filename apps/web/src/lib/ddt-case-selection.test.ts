import { describe, expect, it } from "vitest";

import { matchDdtCaseIds, parseDdtCaseIdCells, parseDdtCaseIdColumn } from "./ddt-case-selection";

describe("DDT case list selection", () => {
  it("reads only the first column, skips a header, deduplicates and preserves CaseID punctuation", () => {
    expect(
      parseDdtCaseIdColumn(
        '\uFEFFCaseID,CaseName\n0001,登录\n/order//1/,支付\nCASE-X\ncase-x\n"CASE,A",名称',
      ),
    ).toEqual(["0001", "/order//1/", "CASE-X", "CASE,A"]);
    expect(parseDdtCaseIdColumn("用例编号\t名称\nCASE-1\t名称")).toEqual(["CASE-1"]);
    expect(parseDdtCaseIdColumn('\uFEFF"CaseID",CaseName\n"0001",名称')).toEqual(["0001"]);
    expect(parseDdtCaseIdColumn('CaseID\tCaseName\n"CASE,A"\t名称\nCASE,B\t名称')).toEqual([
      "CASE,A",
      "CASE,B",
    ]);
    expect(parseDdtCaseIdCells(["", "CaseID", "CaseID", " A "])).toEqual(["CaseID", "A"]);
  });

  it("rejects excessively long IDs instead of silently changing them", () => {
    expect(() => parseDdtCaseIdCells(["a".repeat(513)])).toThrow("512");
  });

  it("matches 100,000 IDs in bounded sequential requests with canonical IDs and missing results", async () => {
    const requested = Array.from({ length: 100_000 }, (_, index) => `case-${index}`);
    let calls = 0;
    let active = false;
    const result = await matchDdtCaseIds(
      requested,
      async (ids) => {
        expect(ids.length).toBeLessThanOrEqual(200);
        expect(active).toBe(false);
        active = true;
        await Promise.resolve();
        active = false;
        calls += 1;
        return ids.filter((id) => id !== "case-1").map((id) => id.toUpperCase());
      },
      new AbortController().signal,
    );
    expect(calls).toBe(500);
    expect(result.matched).toHaveLength(99_999);
    expect(result.matched[0]).toBe("CASE-0");
    expect(result.unmatched).toEqual(["case-1"]);
  });

  it("rejects a partial result on failure or cancellation", async () => {
    const ids = Array.from({ length: 201 }, (_, index) => String(index));
    await expect(
      matchDdtCaseIds(
        ids,
        async (batch) => {
          if (batch.length === 1) throw new Error("database busy");
          return batch;
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("database busy");
    const controller = new AbortController();
    await expect(
      matchDdtCaseIds(
        ids,
        async (batch) => {
          controller.abort();
          return batch;
        },
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
