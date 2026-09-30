import { isTerminalBatchStatus, type RunBatch } from "@autoforge/domain";

type DebugBatchResult = Pick<
  RunBatch,
  "status" | "totalRuns" | "succeededRuns" | "failedRuns" | "timedOutRuns" | "cancelledRuns"
>;

type DebugResultPresentation = {
  label: string;
  color: "success" | "error" | "warning" | "default";
};

/** Batch completion is a lifecycle signal; only authoritative run counts determine passing. */
export function caseDebugResult(batch: DebugBatchResult): DebugResultPresentation | undefined {
  if (!isTerminalBatchStatus(batch.status)) return undefined;
  if (batch.status === "cancelled" || batch.cancelledRuns > 0)
    return { label: "已终止", color: "default" };
  if (batch.timedOutRuns > 0) return { label: "执行超时", color: "warning" };
  if (batch.status === "failed" || batch.failedRuns > 0)
    return { label: "执行失败", color: "error" };
  if (batch.totalRuns > 0 && batch.succeededRuns === batch.totalRuns)
    return { label: "执行通过", color: "success" };
  return { label: "结果待确认", color: "default" };
}
