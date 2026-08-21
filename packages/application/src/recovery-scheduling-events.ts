import { isRetryableRunnerFailure } from "@autoforge/domain";

import type {
  AttemptRecoveryReason,
  ExecutionControlRepository,
  IdGenerator,
  RecoveredAttemptExpiration,
  RunBatchRepository,
} from "./ports";
import { resolveAttemptSchedulingContexts } from "./attempt-scheduling-contexts";

// recoverExpired 四种回收原因到调度事件文案的映射；resultCode 与仓储层
// attemptExpiration 写入 run_attempts.result_code 的取值保持一致。
const ATTEMPT_RECOVERY_REASONS: Record<
  AttemptRecoveryReason,
  { outcome: "failed" | "timed_out"; label: "失败" | "超时"; resultCode: string; summary: string }
> = {
  claim_timeout: {
    outcome: "failed",
    label: "失败",
    resultCode: "ASSIGNMENT_CLAIM_TIMEOUT",
    summary: "任务在领取截止前无人领取",
  },
  lease_expired: {
    outcome: "failed",
    label: "失败",
    resultCode: "LEASE_EXPIRED",
    summary: "执行机掉线，租约过期未完成",
  },
  execution_timeout: {
    outcome: "timed_out",
    label: "超时",
    resultCode: "EXECUTION_TIMEOUT",
    summary: "执行超过配置的超时时间",
  },
  upload_timeout: {
    outcome: "timed_out",
    label: "超时",
    resultCode: "UPLOAD_TIMEOUT",
    summary: "产物上传或完成上报超过配置的超时时间",
  },
};

type SchedulingEventInput = Parameters<RunBatchRepository["appendSchedulingEvents"]>[0];

// 为 recoverExpired 回收的 attempt 组装调度事件：前端只渲染 message，
// 因此原因码与场景摘要必须写进 message；retryScheduled 时文案不得暗示终局。
export async function buildRecoverySchedulingEvents(input: {
  recovered: readonly RecoveredAttemptExpiration[];
  executions: ExecutionControlRepository;
  recordedAt: string;
  nextEventId: IdGenerator["next"];
}): Promise<SchedulingEventInput> {
  const events: SchedulingEventInput = [];
  const contexts = await resolveAttemptSchedulingContexts(
    input.executions,
    input.recovered.map((detail) => detail.attemptId),
  );
  for (const detail of input.recovered) {
    const context = contexts.get(detail.attemptId);
    if (!context) continue;
    const reason = ATTEMPT_RECOVERY_REASONS[detail.reason];
    events.push({
      id: input.nextEventId(),
      batchId: detail.batchId,
      ...(detail.runnerId ? { runnerId: detail.runnerId } : {}),
      executionRunId: detail.executionRunId,
      attemptId: detail.attemptId,
      eventType: "attempt_completed",
      message:
        `用例「${context.displayName}」第 ${context.attemptNumber} 次执行${reason.label}` +
        `（${reason.resultCode}：${reason.summary}）` +
        (detail.retryScheduled ? "，将安排重试" : ""),
      payload: {
        attemptNumber: context.attemptNumber,
        outcome: reason.outcome,
        resultCode: reason.resultCode,
        recoveryReason: detail.reason,
        retryScheduled: detail.retryScheduled,
      },
      recordedAt: input.recordedAt,
    });
    if (detail.retryScheduled && isRetryableRunnerFailure(reason.resultCode)) {
      events.push({
        id: input.nextEventId(),
        batchId: detail.batchId,
        ...(detail.runnerId ? { runnerId: detail.runnerId } : {}),
        executionRunId: detail.executionRunId,
        attemptId: detail.attemptId,
        eventType: "runner_fault_rescheduled",
        message: `非用例异常导致用例「${context.displayName}」自动重新调度（${reason.resultCode}）`,
        payload: {
          resultCode: reason.resultCode,
          summary: reason.summary,
          recoveryReason: detail.reason,
        },
        recordedAt: input.recordedAt,
      });
    }
  }
  return events;
}
