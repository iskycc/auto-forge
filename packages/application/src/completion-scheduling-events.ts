import { isRetryableRunnerFailure } from "@autoforge/domain";
import type { CompletionResult } from "@autoforge/contracts";

import type { AttemptSchedulingContext, SchedulingEventDraft } from "./ports";

// 调度日志只渲染 message，失败摘要必须压成单行短文本随消息展示。
const SCHEDULING_SUMMARY_LIMIT = 300;

// 完成结果的中文文案，用于调度事件消息。
export const COMPLETION_OUTCOME_LABELS: Record<
  "succeeded" | "failed" | "timed_out" | "cancelled",
  string
> = {
  succeeded: "成功",
  failed: "失败",
  timed_out: "超时",
  cancelled: "已取消",
};

export interface CompletionEventDependencies {
  nextId(): string;
  now(): string;
}

/**
 * 组装完成上报被接受后的调度事件。纯函数：主线程完成路径与工作线程卸载路径
 * 共用同一实现，保证两种执行位置产生完全一致的事件内容。
 */
export function buildAttemptCompletionEvents(
  dependencies: CompletionEventDependencies,
  attemptId: string,
  context: AttemptSchedulingContext,
  result: CompletionResult,
  retryScheduled: boolean,
): SchedulingEventDraft[] {
  const recordedAt = dependencies.now();
  const outcome = result.status;
  const reasonSuffix = outcome === "succeeded" ? "" : completionReasonSuffix(result);
  const failureSummary = outcome === "succeeded" ? "" : compactFailureSummary(result.summary);
  const events: SchedulingEventDraft[] = [
    {
      id: dependencies.nextId(),
      batchId: context.batchId,
      runnerId: context.runnerId,
      executionRunId: context.executionRunId,
      attemptId,
      eventType: "attempt_completed",
      message: `用例「${context.displayName}」第 ${context.attemptNumber} 次执行${COMPLETION_OUTCOME_LABELS[outcome]}${reasonSuffix}`,
      payload: {
        attemptNumber: context.attemptNumber,
        outcome,
        durationMs: result.durationMs,
        ...(result.resultCode ? { resultCode: result.resultCode } : {}),
        ...(failureSummary ? { summary: failureSummary } : {}),
      },
      recordedAt,
    },
  ];
  if (retryScheduled) {
    const runnerFault = isRetryableRunnerFailure(result.resultCode);
    events.push({
      id: dependencies.nextId(),
      batchId: context.batchId,
      ...(runnerFault ? { runnerId: context.runnerId } : {}),
      executionRunId: context.executionRunId,
      attemptId,
      eventType: runnerFault ? "runner_fault_rescheduled" : "run_held_for_round",
      message: runnerFault
        ? `执行机异常导致用例「${context.displayName}」自动重新调度（${result.resultCode}）`
        : `该用例已失败，等待下一轮重试${result.resultCode ? `（${result.resultCode}）` : ""}`,
      payload: {
        ...(context.heldRound !== undefined ? { heldRound: context.heldRound } : {}),
        ...(result.resultCode ? { resultCode: result.resultCode } : {}),
        ...(failureSummary ? { summary: failureSummary } : {}),
      },
      recordedAt,
    });
  }
  return events;
}

function compactFailureSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim().slice(0, SCHEDULING_SUMMARY_LIMIT);
}

// 调度日志只渲染 message，非成功结果必须在消息里带原因码与精简摘要；
// resultCode 缺失（防御）时不追加括号段。
function completionReasonSuffix(result: CompletionResult): string {
  if (!result.resultCode) return "";
  const summary = compactFailureSummary(result.summary);
  return summary ? `（${result.resultCode}：${summary}）` : `（${result.resultCode}）`;
}
