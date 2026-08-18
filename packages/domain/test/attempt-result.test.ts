import { describe, expect, it } from "vitest";

import { classifyAttemptResult } from "../src/attempt-result";

describe("classifyAttemptResult", () => {
  it("treats succeeded outcomes as normal success", () => {
    expect(classifyAttemptResult({ outcome: "succeeded", resultCode: "TESTNG_SUCCEEDED" })).toBe(
      "succeeded",
    );
    expect(classifyAttemptResult({ outcome: "succeeded" })).toBe("succeeded");
  });

  it("treats assertion and configuration failures as normal failure", () => {
    expect(
      classifyAttemptResult({ outcome: "failed", resultCode: "TESTNG_ASSERTIONS_FAILED" }),
    ).toBe("failed");
    expect(
      classifyAttemptResult({ outcome: "failed", resultCode: "TESTNG_CONFIGURATION_FAILED" }),
    ).toBe("failed");
    // 历史数据与既有验收链路使用的旧断言失败码同样属于正常失败。
    expect(classifyAttemptResult({ outcome: "failed", resultCode: "TEST_ASSERTION_FAILED" })).toBe(
      "failed",
    );
  });

  it("treats the legacy PASSED code as normal success", () => {
    expect(classifyAttemptResult({ outcome: "succeeded", resultCode: "PASSED" })).toBe("succeeded");
  });

  it("treats timeouts as blocked", () => {
    expect(classifyAttemptResult({ outcome: "timed_out", resultCode: "EXECUTION_TIMEOUT" })).toBe(
      "blocked",
    );
    expect(
      classifyAttemptResult({ outcome: "timed_out", resultCode: "ADAPTER_CASE_TIMEOUT" }),
    ).toBe("blocked");
  });

  it("treats cancellations as blocked", () => {
    expect(
      classifyAttemptResult({ outcome: "cancelled", resultCode: "CANCELLED_BY_CONTROL_PLANE" }),
    ).toBe("blocked");
    expect(classifyAttemptResult({ outcome: "cancelled" })).toBe("blocked");
  });

  it("treats failed outcomes without a normal failure code as blocked", () => {
    expect(classifyAttemptResult({ outcome: "failed", resultCode: "TESTNG_EXIT_NONZERO" })).toBe(
      "blocked",
    );
    expect(
      classifyAttemptResult({ outcome: "failed", resultCode: "AGENT_RESTARTED_DURING_EXECUTION" }),
    ).toBe("blocked");
    expect(classifyAttemptResult({ outcome: "failed", resultCode: "LOG_LIMIT_EXCEEDED" })).toBe(
      "blocked",
    );
    expect(
      classifyAttemptResult({ outcome: "failed", resultCode: "RESOURCE_MEMORY_EXCEEDED" }),
    ).toBe("blocked");
    expect(classifyAttemptResult({ outcome: "failed", resultCode: "TESTNG_NO_TESTS" })).toBe(
      "blocked",
    );
    expect(classifyAttemptResult({ outcome: "failed" })).toBe("blocked");
  });

  it("prefers a normal success code when historical outcome and code disagree", () => {
    expect(
      classifyAttemptResult({ outcome: "failed", resultCode: "TESTNG_SUCCEEDED_WITH_SKIPS" }),
    ).toBe("succeeded");
  });
});
