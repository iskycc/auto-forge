import type { RunAttempt, RunBatch, RunBatchDetails } from "@autoforge/domain";

import { formatPlatformDateTime } from "./platform-date-time";

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
    succeeded: "执行完成",
    failed: "执行异常",
    cancelled: "已终止",
  };
  return labels[status];
}

export function runBatchCompletionLabel<
  Batch extends Pick<RunBatchDetails, "status" | "terminationRequestedAt">,
>(batch: Batch): string {
  if (batch.terminationRequestedAt && isActiveRunBatch(batch.status)) return "终止中";
  // status 是控制面按完整执行集合聚合的权威生命周期。详情中的 attempts 可能经过分页，
  // 不能用不完整的展示数据再次推导，否则正常结束但存在断言失败的批次会被误报为异常。
  return runBatchStatusLabel(batch.status);
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

export function runBatchPassRate<Batch extends Pick<RunBatch, "succeededRuns" | "totalRuns">>(
  batch: Batch,
): number {
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

// 终态失败提示优先展示可读错误描述；仅在执行机没有上报描述时回退机器码。
// 机器码仍保留在详情数据与事件中用于检索，不应取代用户排障所需的信息。
export function attemptFailureHint(
  attempt: Pick<RunAttempt, "outcome" | "resultCode" | "resultSummary">,
): string {
  const resultCode = attempt.resultCode ?? "";
  const summary = attempt.resultSummary?.trim() ?? "";
  return summary || resultCode;
}

// 详情页时间统一用平台时区展示；UTC 原值由调用方放在 title 中提供。
export function formatLocalDateTime(value: string, timeZone?: string): string {
  return formatPlatformDateTime(value, timeZone);
}

export function formatAttemptDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(2)} s`;
  return `${Math.floor(durationMs / 60_000)} min ${Math.round((durationMs % 60_000) / 1_000)} s`;
}

export function formatArtifactBytes(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_048_576) return `${(sizeBytes / 1_024).toFixed(1)} KiB`;
  return `${(sizeBytes / 1_048_576).toFixed(1)} MiB`;
}
