import type { RunAttempt, RunBatch } from "@autoforge/domain";

const activeStatuses = new Set<RunBatch["status"]>([
  "queued",
  "dispatching",
  "scheduled",
  "running",
]);

export function isActiveRunBatch(status: RunBatch["status"]): boolean {
  return activeStatuses.has(status);
}

export function runBatchStatusLabel(status: RunBatch["status"]): string {
  const labels: Record<RunBatch["status"], string> = {
    queued: "等待资源",
    dispatching: "分配中",
    scheduled: "已生成分配",
    running: "执行中",
    succeeded: "已成功",
    failed: "已失败",
    cancelled: "已取消",
  };
  return labels[status];
}

export function runBatchCoveragePercent(batch: RunBatch): number {
  if (batch.totalRuns === 0) return 0;
  const coveredRuns =
    batch.assignedRuns +
    batch.succeededRuns +
    batch.failedRuns +
    batch.timedOutRuns +
    batch.cancelledRuns;
  return Math.min(100, Math.round((coveredRuns / batch.totalRuns) * 100));
}

export function runBatchCompletionPercent(batch: RunBatch): number {
  if (batch.totalRuns === 0) return 0;
  const completedRuns =
    batch.succeededRuns + batch.failedRuns + batch.timedOutRuns + batch.cancelledRuns;
  return Math.min(100, Math.round((completedRuns / batch.totalRuns) * 100));
}

export function runBatchPassRate(batch: RunBatch): number {
  if (batch.totalRuns === 0) return 0;
  return Math.round((batch.succeededRuns / batch.totalRuns) * 100);
}

const terminalStatuses = new Set<RunBatch["status"]>(["succeeded", "failed", "cancelled"]);

export function runBatchDurationMs(batch: RunBatch): number {
  const start = Date.parse(batch.createdAt);
  // 终态批次的 updatedAt 即结束时间；进行中的批次展示已消耗时长。
  const end = Date.parse(batch.updatedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return end - start;
}

export function isTerminalRunBatch(status: RunBatch["status"]): boolean {
  return terminalStatuses.has(status);
}

export function formatBatchDuration(durationMs: number): string {
  if (durationMs <= 0) return "-";
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function batchTestNames(attempts: readonly RunAttempt[]): string[] {
  const names = new Set<string>();
  for (const attempt of attempts) {
    for (const suite of attempt.testNg?.suites ?? []) {
      for (const test of suite.tests) names.add(test.name);
    }
  }
  return [...names];
}
