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

/** 按 attempt 顺序保留每个用例使用过的 Runner，供普通失败与基础设施失败统一轮询。 */
export function runnerHistoryIdsByExecutionRun(
  attempts: readonly RunAttempt[],
): Record<string, string[]> {
  const orderedAttempts = [...attempts].sort(
    (left, right) =>
      left.attemptNumber - right.attemptNumber ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
  const byRun = new Map<string, string[]>();
  for (const attempt of orderedAttempts) {
    const runnerIds = byRun.get(attempt.executionRunId) ?? [];
    runnerIds.push(attempt.runnerId);
    byRun.set(attempt.executionRunId, runnerIds);
  }
  return Object.fromEntries(byRun);
}
