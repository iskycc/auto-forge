import { describe, expect, it } from "vitest";

import {
  classifyCaseLatestRun,
  computeSelectionStats,
  formatRate,
  matchesOutcomeFilter,
  type CaseLatestRun,
} from "./case-selection-stats";

const latestRuns = new Map<string, CaseLatestRun>([
  ["case-succeeded", { outcome: "succeeded", resultCode: "TESTNG_SUCCEEDED" }],
  ["case-failed", { outcome: "failed", resultCode: "TESTNG_ASSERTIONS_FAILED" }],
  ["case-agent-timeout", { outcome: "timed_out", resultCode: "EXECUTION_TIMEOUT" }],
  ["case-adapter-timeout", { outcome: "failed", resultCode: "ADAPTER_CASE_TIMEOUT" }],
  ["case-cancelled", { outcome: "cancelled", resultCode: "EXECUTION_CANCELLED" }],
  ["case-adapter-crash", { outcome: "failed" }],
]);

describe("classifyCaseLatestRun", () => {
  it("keeps adapter-normal success and failure as their own categories", () => {
    expect(classifyCaseLatestRun({ outcome: "succeeded", resultCode: "TESTNG_SUCCEEDED" })).toBe(
      "succeeded",
    );
    expect(
      classifyCaseLatestRun({ outcome: "failed", resultCode: "TESTNG_ASSERTIONS_FAILED" }),
    ).toBe("failed");
  });

  it("classifies every non-normal exit as blocked", () => {
    expect(classifyCaseLatestRun({ outcome: "timed_out", resultCode: "EXECUTION_TIMEOUT" })).toBe(
      "blocked",
    );
    expect(classifyCaseLatestRun({ outcome: "failed", resultCode: "ADAPTER_CASE_TIMEOUT" })).toBe(
      "blocked",
    );
    expect(classifyCaseLatestRun({ outcome: "cancelled", resultCode: "EXECUTION_CANCELLED" })).toBe(
      "blocked",
    );
    expect(classifyCaseLatestRun({ outcome: "failed" })).toBe("blocked");
  });

  it("rejects cases without any terminal run", () => {
    expect(() => classifyCaseLatestRun(undefined)).toThrow();
  });
});

describe("matchesOutcomeFilter", () => {
  it("keeps every case when the filter is all", () => {
    expect(matchesOutcomeFilter(latestRuns.get("case-succeeded"), "all")).toBe(true);
    expect(matchesOutcomeFilter(undefined, "all")).toBe(true);
  });

  it("matches only adapter-normal successes for the succeeded filter", () => {
    expect(matchesOutcomeFilter(latestRuns.get("case-succeeded"), "succeeded")).toBe(true);
    expect(matchesOutcomeFilter(latestRuns.get("case-failed"), "succeeded")).toBe(false);
    expect(matchesOutcomeFilter(undefined, "succeeded")).toBe(false);
  });

  it("matches only adapter-normal failures for the failed filter", () => {
    expect(matchesOutcomeFilter(latestRuns.get("case-failed"), "failed")).toBe(true);
    expect(matchesOutcomeFilter(latestRuns.get("case-adapter-timeout"), "failed")).toBe(false);
    expect(matchesOutcomeFilter(latestRuns.get("case-succeeded"), "failed")).toBe(false);
    expect(matchesOutcomeFilter(undefined, "failed")).toBe(false);
  });

  it("groups every non-normal exit under the blocked filter", () => {
    expect(matchesOutcomeFilter(latestRuns.get("case-agent-timeout"), "blocked")).toBe(true);
    expect(matchesOutcomeFilter(latestRuns.get("case-adapter-timeout"), "blocked")).toBe(true);
    expect(matchesOutcomeFilter(latestRuns.get("case-cancelled"), "blocked")).toBe(true);
    expect(matchesOutcomeFilter(latestRuns.get("case-adapter-crash"), "blocked")).toBe(true);
    expect(matchesOutcomeFilter(latestRuns.get("case-succeeded"), "blocked")).toBe(false);
    expect(matchesOutcomeFilter(latestRuns.get("case-failed"), "blocked")).toBe(false);
    expect(matchesOutcomeFilter(undefined, "blocked")).toBe(false);
  });

  it("matches only cases without any terminal run for the never filter", () => {
    expect(matchesOutcomeFilter(undefined, "never")).toBe(true);
    expect(matchesOutcomeFilter(latestRuns.get("case-cancelled"), "never")).toBe(false);
  });
});

describe("computeSelectionStats", () => {
  it("counts each category bucket for checked cases", () => {
    const stats = computeSelectionStats(
      new Set([
        "case-succeeded",
        "case-failed",
        "case-agent-timeout",
        "case-adapter-timeout",
        "case-cancelled",
        "case-adapter-crash",
        "case-new",
      ]),
      latestRuns,
    );
    expect(stats).toEqual({
      total: 7,
      succeededCount: 1,
      failedCount: 1,
      blockedCount: 4,
      notRunCount: 1,
      successRate: "14.3%",
      failureRate: "14.3%",
      blockedRate: "57.1%",
    });
  });

  it("returns zero rates for an empty selection", () => {
    expect(computeSelectionStats(new Set(), latestRuns)).toEqual({
      total: 0,
      succeededCount: 0,
      failedCount: 0,
      blockedCount: 0,
      notRunCount: 0,
      successRate: "0.0%",
      failureRate: "0.0%",
      blockedRate: "0.0%",
    });
  });

  it("ignores unchecked cases", () => {
    const stats = computeSelectionStats(new Set(["case-failed"]), latestRuns);
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
