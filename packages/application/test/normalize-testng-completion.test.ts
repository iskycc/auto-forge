import { describe, expect, it } from "vitest";
import type { CompletionResult } from "@autoforge/contracts";
import { normalizeTestNgCompletion } from "../src/normalize-testng-completion";

function result(passed: number, failed: number, skipped: number): CompletionResult {
  return {
    status: "succeeded",
    resultCode: "TESTNG_SUCCEEDED",
    summary: "old Runner reported success",
    durationMs: 1,
    artifacts: [],
    testNg: {
      total: passed + failed + skipped,
      passed,
      failed,
      skipped,
      configurationFailures: 0,
      detailsTruncated: false,
      suites: [],
    },
  };
}

describe("authoritative TestNG completion", () => {
  it.each([
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 0],
  ])("rejects success when Failed or Skipped is nonzero (%i/%i/%i)", (passed, failed, skipped) => {
    expect(normalizeTestNgCompletion(result(passed, failed, skipped))).toMatchObject({
      status: "failed",
      resultCode: failed ? "TESTNG_ASSERTIONS_FAILED" : "TESTNG_SKIPPED",
    });
  });
  it("preserves passing results and rejects empty runs", () => {
    const passing = result(1, 0, 0);
    expect(normalizeTestNgCompletion(passing)).toBe(passing);
    expect(normalizeTestNgCompletion(result(0, 0, 0))).toMatchObject({
      status: "failed",
      resultCode: "TESTNG_NO_TESTS",
    });
  });
  it.each(["TESTNG_ALL_SKIPPED", "TESTNG_SUCCEEDED_WITH_SKIPS"])(
    "rejects legacy %s even without a structured report",
    (resultCode) => {
      const legacy = result(0, 0, 1);
      delete legacy.testNg;
      expect(normalizeTestNgCompletion({ ...legacy, resultCode })).toMatchObject({
        status: "failed",
        resultCode: "TESTNG_SKIPPED",
      });
    },
  );
  it.each(["cancelled", "timed_out"] as const)("preserves %s precedence", (status) => {
    const interrupted = { ...result(0, 0, 1), status };
    expect(normalizeTestNgCompletion(interrupted)).toBe(interrupted);
  });
  it("preserves infrastructure failures even when a partial TestNG report exists", () => {
    const interrupted = {
      ...result(0, 0, 1),
      status: "failed" as const,
      resultCode: "RESOURCE_MEMORY_EXCEEDED",
    };
    expect(normalizeTestNgCompletion(interrupted)).toBe(interrupted);
  });
  it.each([
    "TEST_ASSERTION_FAILED",
    "TESTNG_ASSERTIONS_FAILED",
    "TESTNG_CONFIGURATION_FAILED",
    "TESTNG_SKIPPED",
  ])("preserves a correctly failed Runner result (%s) and its diagnostic summary", (resultCode) => {
    const reportedFailure: CompletionResult = {
      ...result(1, 1, 1),
      status: "failed",
      resultCode,
      summary: "Runner diagnostic with the original exception",
    };
    expect(normalizeTestNgCompletion(reportedFailure)).toBe(reportedFailure);
  });
  it.each(["TESTNG_EXIT_NONZERO", "TESTNG_SUCCEEDED_WITH_SKIPS"])(
    "classifies failed %s from the structured report",
    (resultCode) => {
      expect(
        normalizeTestNgCompletion({ ...result(0, 0, 1), status: "failed", resultCode }),
      ).toMatchObject({ status: "failed", resultCode: "TESTNG_SKIPPED" });
    },
  );
});
