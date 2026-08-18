import type { LatestCaseRunOutcome } from "@autoforge/application";

// 用例最近一次终态执行结果的四种取值；没有记录的用例视为“未执行”。
export type CaseLatestOutcome = LatestCaseRunOutcome["outcome"];

export type CaseOutcomeFilter = "all" | "succeeded" | "failed" | "never";

// “最近失败”包含 failed/timed_out/cancelled，成功与失败互斥、与“从未执行”互补。
export function matchesOutcomeFilter(
  outcome: CaseLatestOutcome | undefined,
  filter: CaseOutcomeFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "succeeded":
      return outcome === "succeeded";
    case "failed":
      return outcome === "failed" || outcome === "timed_out" || outcome === "cancelled";
    case "never":
      return outcome === undefined;
  }
}

export type CaseSelectionStats = {
  total: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  notRunCount: number;
  successRate: string;
  failureRate: string;
  blockedRate: string;
};

// 阻塞率 = 未执行数 / 总数；失败率 = （failed + timed_out）/ 总数。
export function computeSelectionStats(
  checkedCaseIds: ReadonlySet<string>,
  outcomes: ReadonlyMap<string, CaseLatestOutcome>,
): CaseSelectionStats {
  let succeededCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;
  let notRunCount = 0;
  for (const caseId of checkedCaseIds) {
    const outcome = outcomes.get(caseId);
    if (outcome === undefined) notRunCount += 1;
    else if (outcome === "succeeded") succeededCount += 1;
    else if (outcome === "cancelled") cancelledCount += 1;
    else failedCount += 1;
  }
  const total = checkedCaseIds.size;
  return {
    total,
    succeededCount,
    failedCount,
    cancelledCount,
    notRunCount,
    successRate: formatRate(succeededCount, total),
    failureRate: formatRate(failedCount, total),
    blockedRate: formatRate(notRunCount, total),
  };
}

export function formatRate(count: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((count / total) * 100).toFixed(1)}%`;
}
