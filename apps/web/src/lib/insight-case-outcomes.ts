import { classifyAttemptResult } from "@autoforge/domain";
import { computeSelectionStats, type CaseLatestRun } from "./case-selection-stats";

type OutcomeCase = { id: string; displayName: string };

export function summarizeInsightCaseOutcomes(report: {
  cases: readonly OutcomeCase[];
  outcomes: ReadonlyMap<string, CaseLatestRun>;
  executedAt: ReadonlyMap<string, string>;
}) {
  const stats = computeSelectionStats(
    new Set(report.cases.map((item) => item.id)),
    report.outcomes,
  );
  const counts = {
    total: stats.total,
    succeeded: stats.succeededCount,
    failed: stats.failedCount,
    blocked: stats.blockedCount,
    neverRun: stats.notRunCount,
  };
  const executed = counts.total - counts.neverRun;
  let latestExecutedAt: string | undefined;
  const attentionCases: Array<OutcomeCase & { outcome: "failed" | "blocked" }> = [];
  for (const item of report.cases) {
    const run = report.outcomes.get(item.id);
    if (!run) continue;
    const executedAt = report.executedAt.get(item.id);
    if (executedAt && (!latestExecutedAt || Date.parse(executedAt) > Date.parse(latestExecutedAt)))
      latestExecutedAt = executedAt;
    const outcome = classifyAttemptResult(run);
    if (outcome !== "succeeded")
      attentionCases.push({ id: item.id, displayName: item.displayName, outcome });
  }
  // Match the detail view: actionable failures first, then blocked executions.
  attentionCases.sort(
    (left, right) =>
      Number(left.outcome === "blocked") - Number(right.outcome === "blocked") ||
      left.displayName.localeCompare(right.displayName) ||
      left.id.localeCompare(right.id),
  );
  return {
    counts,
    executed,
    coveragePercent: counts.total > 0 ? (executed / counts.total) * 100 : undefined,
    passPercent: executed > 0 ? (counts.succeeded / executed) * 100 : undefined,
    latestExecutedAt,
    attentionCases: attentionCases.slice(0, 3),
  };
}
