import type { ExecutionRunStatus } from "@autoforge/domain";

export type RetryQueueTiming = {
  executionRound: number;
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
  currentExecutionRound: number;
  eligibleAt: string;
  queueTimeoutMs: number;
}): RetryQueueTiming {
  if (input.runStatus !== "queued") {
    return {
      executionRound: input.currentExecutionRound,
      heldRound: 0,
      queueDeadlineAt: null,
    };
  }
  const executionRound =
    input.retryMode === "round" && input.retryableRunnerFailure
      ? input.currentExecutionRound
      : input.currentExecutionRound + 1;
  const heldRound =
    input.retryMode === "round" && !input.retryableRunnerFailure ? executionRound : 0;
  return {
    executionRound,
    heldRound,
    // 整轮重跑等待和 Jenkins 环境恢复不属于可调度排队时间；释放时再启动新计时窗口。
    queueDeadlineAt:
      heldRound > 0 ? null : queueDeadlineAfter(input.eligibleAt, input.queueTimeoutMs),
  };
}
