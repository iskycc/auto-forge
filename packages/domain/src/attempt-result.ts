// blocked 口径：排除 adapter 执行结果为成功或失败的正常结束，其他任何非正常结束
// （超时被强杀、未拉起 adapter、adapter 执行异常、资源超限、取消、租约过期等）都归为 blocked。
// 采用白名单判定：只有明确的成功/失败结果码才算正常结束，未知或缺失结果码一律 blocked，
// 保证未来新增的异常结果码不需要回头修改分类逻辑。

export type AttemptResultCategory = "succeeded" | "failed" | "blocked";

export type ClassifiableAttemptResult = {
  outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
  resultCode?: string | null;
};

// adapter 正常结束并产出有效测试结果的结果码（含历史数据使用的旧码 PASSED）。
export const ADAPTER_SUCCESS_RESULT_CODES: readonly string[] = [
  "TESTNG_SUCCEEDED",
  "TESTNG_SUCCEEDED_WITH_SKIPS",
  "TESTNG_ALL_SKIPPED",
  "PASSED",
];

// adapter 正常结束、由 TestNG 报告真实失败的结果码（断言失败与配置失败）；
// TEST_ASSERTION_FAILED 为历史数据与既有验收链路使用的旧断言失败码。
export const ADAPTER_FAILURE_RESULT_CODES: readonly string[] = [
  "TESTNG_ASSERTIONS_FAILED",
  "TESTNG_CONFIGURATION_FAILED",
  "TEST_ASSERTION_FAILED",
];

export function classifyAttemptResult(result: ClassifiableAttemptResult): AttemptResultCategory {
  if (result.outcome === "succeeded") return "succeeded";
  if (result.outcome === "failed") {
    const resultCode = result.resultCode ?? "";
    if (ADAPTER_FAILURE_RESULT_CODES.includes(resultCode)) return "failed";
    // 防御：历史数据中 outcome 与结果码不一致时，以结果码表达的正常成功为准。
    if (ADAPTER_SUCCESS_RESULT_CODES.includes(resultCode)) return "succeeded";
    return "blocked";
  }
  // timed_out / cancelled 以及其他 outcome 都属于非正常结束。
  return "blocked";
}
