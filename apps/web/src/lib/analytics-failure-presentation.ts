import { classifyAttemptResult } from "@autoforge/domain";

type AnalyticsFailure = {
  description: string;
  resultCode?: string | undefined;
};

export type AnalyticsFailurePresentation = {
  detail: string;
  errorCode?: string;
  isExecutionFailure: boolean;
};

/**
 * TestNG assertions and configuration failures are valid adapter results. Their
 * internal result codes add noise for users, while infrastructure failures need
 * both the stable code and readable detail for diagnosis.
 */
export function presentAnalyticsFailure(failure: AnalyticsFailure): AnalyticsFailurePresentation {
  const isExecutionFailure =
    classifyAttemptResult({
      outcome: "failed",
      ...(failure.resultCode ? { resultCode: failure.resultCode } : {}),
    }) === "blocked";
  return {
    detail: failure.description.trim() || "未提供错误信息",
    isExecutionFailure,
    ...(isExecutionFailure && failure.resultCode ? { errorCode: failure.resultCode } : {}),
  };
}
