import type { CompletionResult } from "@autoforge/contracts";
import { ADAPTER_FAILURE_RESULT_CODES, ADAPTER_SUCCESS_RESULT_CODES } from "@autoforge/domain";

const LEGACY_SKIP_RESULTS = new Set(["TESTNG_ALL_SKIPPED", "TESTNG_SUCCEEDED_WITH_SKIPS"]);

/** Older Runners may report skips as success; normalize before persistence and retry decisions. */
export function normalizeTestNgCompletion(result: CompletionResult): CompletionResult {
  if (result.status === "cancelled" || result.status === "timed_out") return result;
  if (
    result.status === "failed" &&
    result.resultCode !== "TESTNG_EXIT_NONZERO" &&
    !ADAPTER_SUCCESS_RESULT_CODES.includes(result.resultCode ?? "") &&
    !ADAPTER_FAILURE_RESULT_CODES.includes(result.resultCode ?? "")
  )
    return result;

  const report = result.testNg;
  if (report?.configurationFailures)
    return failed(
      result,
      "TESTNG_CONFIGURATION_FAILED",
      `TestNG 配置失败 ${report.configurationFailures} 项。`,
    );
  if (report?.failed)
    return failed(result, "TESTNG_ASSERTIONS_FAILED", `TestNG 执行失败 ${report.failed} 项。`);
  if (report?.skipped || LEGACY_SKIP_RESULTS.has(result.resultCode ?? ""))
    return failed(
      result,
      "TESTNG_SKIPPED",
      report
        ? `TestNG 通过 ${report.passed} 项、跳过 ${report.skipped} 项，存在跳过，执行不通过。`
        : "TestNG 存在跳过的测试，执行不通过。",
    );
  if (report?.total === 0)
    return failed(result, "TESTNG_NO_TESTS", "TestNG 未执行任何测试，执行不通过。");
  return result;
}

function failed(result: CompletionResult, resultCode: string, summary: string): CompletionResult {
  // Keep a Runner's diagnostic summary when it already reported the correct failure.
  if (result.status === "failed" && result.resultCode === resultCode) return result;
  return { ...result, status: "failed", resultCode, summary };
}
