import { describe, expect, it } from "vitest";

import {
  aggregateAnalytics,
  failureSignature,
  resultCounts,
  type AnalyticsFactRow,
} from "../src/platform-operations-shared";

describe("analytics fact semantics", () => {
  it("reads the current top-level TestNG result counts and keeps legacy rows readable", () => {
    expect(
      resultCounts(
        JSON.stringify({
          total: 4,
          passed: 2,
          failed: 1,
          skipped: 1,
          configurationFailures: 0,
          detailsTruncated: true,
          suites: [],
        }),
      ),
    ).toEqual({ passed: 2, failed: 1, skipped: 1 });
    expect(resultCounts(JSON.stringify({ summary: { passed: 3, failed: 0, skipped: 1 } }))).toEqual(
      { passed: 3, failed: 0, skipped: 1 },
    );
  });

  it("never creates a failure signature for a successful TestNG result", () => {
    expect(
      failureSignature("succeeded", "TESTNG_SUCCEEDED", "TestNG passed 1 test method(s)."),
    ).toBeNull();
    expect(
      failureSignature("failed", "TESTNG_SUCCEEDED", "historical outcome mismatch"),
    ).toBeNull();
    expect(
      failureSignature(
        "failed",
        "TESTNG_ASSERTIONS_FAILED",
        "java.lang.AssertionError: expected 200 but was 500",
      ),
    ).toBe("java.lang.AssertionError: expected <n> but was <n>");
    expect(
      failureSignature("failed", "PROCESS_START_FAILED", "failed to start the process"),
    ).toBeNull();
  });

  it("uses method totals for daily trends, descriptions for failures and names for flaky cases", () => {
    const rows = [
      fact("attempt-1", "2026-08-18T01:00:00.000Z", "succeeded", "TESTNG_SUCCEEDED", 1, 0),
      fact("attempt-2", "2026-08-18T02:00:00.000Z", "failed", "TESTNG_ASSERTIONS_FAILED", 0, 1, {
        failureSignature: "java.lang.AssertionError: expected <n> but was <n>",
        failureDescription: "java.lang.AssertionError: expected 200 but was 500",
      }),
      fact("attempt-3", "2026-08-19T01:00:00.000Z", "succeeded", "TESTNG_SUCCEEDED", 1, 0),
      fact("attempt-4", "2026-08-19T02:00:00.000Z", "failed", "TESTNG_ASSERTIONS_FAILED", 0, 1, {
        failureSignature: "java.lang.AssertionError: expected <n> but was <n>",
        failureDescription: "java.lang.AssertionError: expected 201 but was 503",
      }),
      fact("attempt-5", "2026-08-19T03:00:00.000Z", "succeeded", "TESTNG_SUCCEEDED", 1, 0),
    ];

    const summary = aggregateAnalytics(rows, "2026-08-20T00:00:00.000Z");

    expect(summary).toMatchObject({
      sampleCount: 5,
      passed: 3,
      failed: 2,
      successRate: 0.6,
      failureRate: 0.4,
      trend: [
        { bucket: "2026-08-18T00:00:00.000Z", total: 2, passed: 1, failed: 1 },
        { bucket: "2026-08-19T00:00:00.000Z", total: 3, passed: 2, failed: 1 },
      ],
      failures: [
        {
          signature: "java.lang.AssertionError: expected <n> but was <n>",
          description: "java.lang.AssertionError: expected 201 but was 503",
          count: 2,
        },
      ],
      flakyCases: [
        {
          caseDefinitionId: "case-checkout",
          displayName: "结算接口校验",
          samples: 5,
          passed: 3,
          failed: 2,
        },
      ],
    });
    expect(summary.failures).toHaveLength(1);
  });

  it("keeps retryable Runner failures out of quality analytics", () => {
    const summary = aggregateAnalytics(
      [
        fact("attempt-1", "2026-08-19T01:00:00.000Z", "succeeded", "TESTNG_SUCCEEDED", 1, 0),
        fact("attempt-2", "2026-08-19T02:00:00.000Z", "failed", "PROCESS_START_FAILED", 0, 0, {
          failureSignature: "failed to start the process",
          failureDescription: "failed to start the process",
        }),
      ],
      "2026-08-20T00:00:00.000Z",
    );

    expect(summary).toMatchObject({
      sampleCount: 1,
      passed: 1,
      failed: 0,
      successRate: 1,
      failures: [],
      flakyCases: [],
    });
  });

  it("groups trend samples by the configured platform calendar day", () => {
    const rows = [
      fact("attempt-1", "2026-08-18T15:59:00.000Z", "succeeded", "TESTNG_SUCCEEDED", 1, 0),
      fact("attempt-2", "2026-08-18T16:01:00.000Z", "succeeded", "TESTNG_SUCCEEDED", 1, 0),
    ];

    expect(aggregateAnalytics(rows, "2026-08-20T00:00:00.000Z", "Asia/Shanghai").trend).toEqual([
      { bucket: "2026-08-18T00:00:00.000Z", total: 1, passed: 1, failed: 0, skipped: 0 },
      { bucket: "2026-08-19T00:00:00.000Z", total: 1, passed: 1, failed: 0, skipped: 0 },
    ]);
  });
});

function fact(
  attemptId: string,
  completedAt: string,
  outcome: "succeeded" | "failed",
  resultCode: string,
  passed: number,
  failed: number,
  failure?: { failureSignature: string; failureDescription: string },
): AnalyticsFactRow {
  return {
    attempt_id: attemptId,
    project_id: "project-1",
    batch_id: "batch-1",
    run_id: `run-${attemptId}`,
    suite_id: "suite-1",
    case_definition_id: "case-checkout",
    case_display_name: "结算接口校验",
    case_version: 1,
    runner_id: "runner-1",
    environment_version_id: null,
    outcome,
    result_code: resultCode,
    failure_signature: failure?.failureSignature ?? null,
    failure_description: failure?.failureDescription ?? null,
    duration_ms: 100,
    passed,
    failed,
    skipped: 0,
    completed_at: completedAt,
  };
}
