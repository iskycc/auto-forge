import { DomainError } from "./errors";
import { isTerminalBatchStatus } from "./execution";
import type { RunBatchStatus } from "./run-batch";

export function shouldChangeBatchScheduling(
  batch: {
    status: RunBatchStatus;
    terminationRequestedAt: string | null;
    pauseRequestedAt: string | null;
  },
  action: "pause" | "resume",
): boolean {
  if (isTerminalBatchStatus(batch.status) || batch.terminationRequestedAt) {
    throw new DomainError("RUN_BATCH_NOT_ACTIVE", "批次已结束或正在终止，不能暂停或继续调度。");
  }
  return (action === "pause") !== Boolean(batch.pauseRequestedAt);
}
