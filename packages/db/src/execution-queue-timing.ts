import type { ExecutionRunStatus } from "@autoforge/domain";

export type RetryQueueTiming = {
  heldRound: number;
  queueDeadlineAt: string | null;
};

export function queueDeadlineAfter(eligibleAt: string, queueTimeoutMs: number): string {
  return new Date(new Date(eligibleAt).getTime() + queueTimeoutMs).toISOString();
}

export function retryQueueTiming(input: {
  runStatus: ExecutionRunStatus;
  retryMode: "immediate" | "round";
  retryableRunnerFailure: boolean;
  attemptNumber: number;
  eligibleAt: string;
  queueTimeoutMs: number;
}): RetryQueueTiming {
  if (input.runStatus !== "queued") {
    return { heldRound: 0, queueDeadlineAt: null };
  }
  const heldRound =
    input.retryMode === "round" && !input.retryableRunnerFailure ? input.attemptNumber + 1 : 0;
  return {
    heldRound,
    // 整轮重跑等待和 Jenkins 环境恢复不属于可调度排队时间；释放时再启动新计时窗口。
    queueDeadlineAt:
      heldRound > 0 ? null : queueDeadlineAfter(input.eligibleAt, input.queueTimeoutMs),
  };
}
