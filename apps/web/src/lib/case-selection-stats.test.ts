import { describe, expect, it } from "vitest";

import {
  computeSelectionStats,
  formatRate,
  matchesOutcomeFilter,
  type CaseLatestOutcome,
} from "./case-selection-stats";

const outcomes = new Map<string, CaseLatestOutcome>([
  ["case-succeeded", "succeeded"],
  ["case-failed", "failed"],
  ["case-timed-out", "timed_out"],
  ["case-cancelled", "cancelled"],
]);

describe("matchesOutcomeFilter", () => {
  it("keeps every case when the filter is all", () => {
    expect(matchesOutcomeFilter("succeeded", "all")).toBe(true);
    expect(matchesOutcomeFilter(undefined, "all")).toBe(true);
  });

  it("matches only succeeded outcomes for the succeeded filter", () => {
    expect(matchesOutcomeFilter("succeeded", "succeeded")).toBe(true);
    expect(matchesOutcomeFilter("failed", "succeeded")).toBe(false);
    expect(matchesOutcomeFilter(undefined, "succeeded")).toBe(false);
  });

  it("groups failed, timed out and cancelled under the failed filter", () => {
    expect(matchesOutcomeFilter("failed", "failed")).toBe(true);
    expect(matchesOutcomeFilter("timed_out", "failed")).toBe(true);
    expect(matchesOutcomeFilter("cancelled", "failed")).toBe(true);
    expect(matchesOutcomeFilter("succeeded", "failed")).toBe(false);
    expect(matchesOutcomeFilter(undefined, "failed")).toBe(false);
  });

  it("matches only cases without any terminal run for the never filter", () => {
    expect(matchesOutcomeFilter(undefined, "never")).toBe(true);
    expect(matchesOutcomeFilter("succeeded", "never")).toBe(false);
    expect(matchesOutcomeFilter("cancelled", "never")).toBe(false);
  });
});

describe("computeSelectionStats", () => {
  it("counts each outcome bucket for checked cases", () => {
    const stats = computeSelectionStats(
      new Set(["case-succeeded", "case-failed", "case-timed-out", "case-cancelled", "case-new"]),
      outcomes,
    );
    expect(stats).toEqual({
      total: 5,
      succeededCount: 1,
      failedCount: 2,
      cancelledCount: 1,
      notRunCount: 1,
      successRate: "20.0%",
      failureRate: "40.0%",
      blockedRate: "20.0%",
    });
  });

  it("returns zero rates for an empty selection", () => {
    expect(computeSelectionStats(new Set(), outcomes)).toEqual({
      total: 0,
      succeededCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      notRunCount: 0,
      successRate: "0.0%",
      failureRate: "0.0%",
      blockedRate: "0.0%",
    });
  });

  it("ignores unchecked cases", () => {
    const stats = computeSelectionStats(new Set(["case-failed"]), outcomes);
    expect(stats.total).toBe(1);
    expect(stats.failedCount).toBe(1);
    expect(stats.successRate).toBe("0.0%");
    expect(stats.failureRate).toBe("100.0%");
  });
});

describe("formatRate", () => {
  it("renders one decimal percent", () => {
    expect(formatRate(1, 3)).toBe("33.3%");
    expect(formatRate(2, 3)).toBe("66.7%");
    expect(formatRate(0, 4)).toBe("0.0%");
    expect(formatRate(4, 4)).toBe("100.0%");
  });

  it("guards against an empty denominator", () => {
    expect(formatRate(1, 0)).toBe("0.0%");
  });
});
