import type { RunBatchDetails } from "@autoforge/domain";

/**
 * 执行详情实际渲染所需的最小批次快照。公开页也使用该 DTO，避免把历史环境变量、
 * 密文引用、任务 ID、调度超时与未展示的状态历史序列化到匿名浏览器。
 */
export type ExecutionBatchView = Pick<
  RunBatchDetails,
  | "id"
  | "status"
  | "retryLimit"
  | "retryMode"
  | "currentRound"
  | "totalRuns"
  | "succeededRuns"
  | "failedRuns"
  | "timedOutRuns"
  | "terminationRequestedAt"
  | "scheduledFor"
  | "updatedAt"
  | "runs"
  | "attempts"
  | "roundRecoveries"
>;

export function toExecutionBatchView(batch: RunBatchDetails): ExecutionBatchView {
  return {
    id: batch.id,
    status: batch.status,
    retryLimit: batch.retryLimit,
    retryMode: batch.retryMode,
    currentRound: batch.currentRound,
    totalRuns: batch.totalRuns,
    succeededRuns: batch.succeededRuns,
    failedRuns: batch.failedRuns,
    timedOutRuns: batch.timedOutRuns,
    ...(batch.terminationRequestedAt
      ? { terminationRequestedAt: batch.terminationRequestedAt }
      : {}),
    scheduledFor: batch.scheduledFor,
    updatedAt: batch.updatedAt,
    runs: batch.runs,
    attempts: batch.attempts,
    roundRecoveries: batch.roundRecoveries,
  };
}
