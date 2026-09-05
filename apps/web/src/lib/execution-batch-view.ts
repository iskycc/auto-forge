import type { ReadModelStatus } from "@autoforge/contracts";
import type { RunBatchDetailOverview } from "@autoforge/application";
import type { RunBatch } from "@autoforge/domain";

/**
 * 执行详情实际渲染所需的最小批次快照。公开页也使用该 DTO，避免把历史环境变量、
 * 密文引用、任务 ID、调度超时与未展示的状态历史序列化到匿名浏览器。
 */
export type ExecutionBatchView = Pick<
  RunBatch,
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
> &
  Pick<
    RunBatchDetailOverview,
    | "roundSummaries"
    | "allRoundsSummary"
    | "finalSummary"
    | "roundRecoveries"
    | "roundConcurrencies"
    | "runnerRoundSummaries"
    | "runnerFaultIncidents"
    | "finishedAt"
  > & { accessToken?: string; statistics?: ReadModelStatus };

export function toExecutionBatchView(
  overview: RunBatchDetailOverview & { statistics?: ReadModelStatus },
): ExecutionBatchView {
  const batch = overview.batch;
  return {
    ...(overview.statistics ? { statistics: overview.statistics } : {}),
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
    roundSummaries: overview.roundSummaries,
    allRoundsSummary: overview.allRoundsSummary,
    finalSummary: overview.finalSummary,
    roundRecoveries: overview.roundRecoveries,
    roundConcurrencies: overview.roundConcurrencies,
    runnerRoundSummaries: overview.runnerRoundSummaries,
    runnerFaultIncidents: overview.runnerFaultIncidents,
    finishedAt: overview.finishedAt,
  };
}
