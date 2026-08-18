import type { LatestCaseRunOutcome } from "@autoforge/application";
import { classifyAttemptResult, type AttemptResultCategory } from "@autoforge/domain";

// 用例最近一次终态执行结果；blocked 口径：除 adapter 正常成功/失败之外的任何
// 非正常结束（超时强杀、未拉起 adapter、adapter 异常、取消等）都归为阻塞。
export type CaseLatestOutcome = LatestCaseRunOutcome["outcome"];

export type CaseLatestRun = Pick<LatestCaseRunOutcome, "outcome" | "resultCode">;

export type CaseOutcomeFilter = "all" | "succeeded" | "failed" | "blocked" | "never";

// 分类仅在存在终态结果时有效；未执行用例没有结果，不进入任何结果分类。
export function classifyCaseLatestRun(run: CaseLatestRun | undefined): AttemptResultCategory {
  if (!run) throw new Error("未执行的用例没有可分类的执行结果。");
  return classifyAttemptResult(run);
}

export function matchesOutcomeFilter(
  run: CaseLatestRun | undefined,
  filter: CaseOutcomeFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "never":
      return run === undefined;
    case "succeeded":
    case "failed":
    case "blocked":
      return run !== undefined && classifyAttemptResult(run) === filter;
  }
}

export type CaseSelectionStats = {
  total: number;
  succeededCount: number;
  failedCount: number;
  blockedCount: number;
  notRunCount: number;
  successRate: string;
  failureRate: string;
  blockedRate: string;
};

// 阻塞率 = 阻塞数 / 总数；阻塞指非正常结束（超时、取消、adapter 异常等），
// 失败率只统计 adapter 正常结束并报告的真实失败。
export function computeSelectionStats(
  checkedCaseIds: ReadonlySet<string>,
  latestRuns: ReadonlyMap<string, CaseLatestRun>,
): CaseSelectionStats {
  let succeededCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  let notRunCount = 0;
  for (const caseId of checkedCaseIds) {
    const run = latestRuns.get(caseId);
    if (!run) {
      notRunCount += 1;
      continue;
    }
    switch (classifyAttemptResult(run)) {
      case "succeeded":
        succeededCount += 1;
        break;
      case "failed":
        failedCount += 1;
        break;
      case "blocked":
        blockedCount += 1;
        break;
    }
  }
  const total = checkedCaseIds.size;
  return {
    total,
    succeededCount,
    failedCount,
    blockedCount,
    notRunCount,
    successRate: formatRate(succeededCount, total),
    failureRate: formatRate(failedCount, total),
    blockedRate: formatRate(blockedCount, total),
  };
}

export function formatRate(count: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((count / total) * 100).toFixed(1)}%`;
}
