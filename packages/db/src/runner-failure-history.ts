import { isRetryableRunnerFailure, type RunAttempt } from "@autoforge/domain";

/** 把历史 Runner 基础设施异常按用例聚合，供 Lite/Full 调度器使用同一避让口径。 */
export function runnerFailureIdsByExecutionRun(
  attempts: readonly RunAttempt[],
): Record<string, string[]> {
  const byRun = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    if (!isRetryableRunnerFailure(attempt.resultCode)) continue;
    const runnerIds = byRun.get(attempt.executionRunId) ?? new Set<string>();
    runnerIds.add(attempt.runnerId);
    byRun.set(attempt.executionRunId, runnerIds);
  }
  return Object.fromEntries(
    [...byRun.entries()].map(([executionRunId, runnerIds]) => [executionRunId, [...runnerIds]]),
  );
}
