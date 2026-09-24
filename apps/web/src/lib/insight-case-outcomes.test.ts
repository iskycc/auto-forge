import { describe, expect, it } from "vitest";
import { summarizeInsightCaseOutcomes } from "./insight-case-outcomes";
import type { CaseLatestRun } from "./case-selection-stats";

describe("insight case outcome overview", () => {
  it("uses only the current page and includes blocked executions in the coverage and pass-rate denominator", () => {
    const cases = ["passed", "failed", "blocked", "unexecuted"].map((id) => ({
      id,
      displayName: id,
    }));
    const summary = summarizeInsightCaseOutcomes({
      cases,
      outcomes: new Map<string, CaseLatestRun>([
        ["passed", { outcome: "succeeded", resultCode: "TESTNG_SUCCEEDED" }],
        ["failed", { outcome: "failed", resultCode: "TESTNG_SKIPPED" }],
        ["blocked", { outcome: "timed_out" }],
        ["other-page", { outcome: "succeeded" }],
      ]),
      executedAt: new Map([
        ["passed", "2026-09-24T02:00:00.000Z"],
        ["failed", "2026-09-24T01:00:00.000Z"],
        ["blocked", "2026-09-24T03:00:00.000Z"],
        ["other-page", "2026-09-25T03:00:00.000Z"],
      ]),
    });
    expect(summary.counts).toEqual({ total: 4, succeeded: 1, failed: 1, blocked: 1, neverRun: 1 });
    expect(summary.executed).toBe(3);
    expect(summary.coveragePercent).toBe(75);
    expect(summary.passPercent).toBeCloseTo(100 / 3);
    expect(summary.latestExecutedAt).toBe("2026-09-24T03:00:00.000Z");
    expect(summary.attentionCases.map((item) => item.id)).toEqual(["failed", "blocked"]);
  });

  it("distinguishes an empty page and an unexecuted page from a failed execution", () => {
    const empty = summarizeInsightCaseOutcomes({
      cases: [],
      outcomes: new Map(),
      executedAt: new Map(),
    });
    expect(empty.coveragePercent).toBeUndefined();
    expect(empty.passPercent).toBeUndefined();
    const unexecuted = summarizeInsightCaseOutcomes({
      cases: [{ id: "unexecuted", displayName: "Unexecuted" }],
      outcomes: new Map(),
      executedAt: new Map(),
    });
    expect(unexecuted.coveragePercent).toBe(0);
    expect(unexecuted.passPercent).toBeUndefined();
    expect(unexecuted.latestExecutedAt).toBeUndefined();
    expect(unexecuted.attentionCases).toEqual([]);
  });

  it("limits attention links to three cases with failures before blocked outcomes", () => {
    const cases = ["blocked", "failure-d", "failure-b", "failure-a", "failure-c"].map((id) => ({
      id,
      displayName: id,
    }));
    const outcomes = new Map<string, CaseLatestRun>(
      cases.map(({ id }) => [
        id,
        id === "blocked"
          ? { outcome: "cancelled" }
          : { outcome: "failed", resultCode: "TESTNG_ASSERTIONS_FAILED" },
      ]),
    );
    const summary = summarizeInsightCaseOutcomes({ cases, outcomes, executedAt: new Map() });
    expect(summary.counts.failed).toBe(4);
    expect(summary.counts.blocked).toBe(1);
    expect(summary.passPercent).toBe(0);
    expect(summary.attentionCases.map(({ id }) => id)).toEqual([
      "failure-a",
      "failure-b",
      "failure-c",
    ]);
    expect(cases[0]?.id).toBe("blocked");
  });
});
