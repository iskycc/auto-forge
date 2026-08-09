import type { RunBatch } from "@autoforge/domain";

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
