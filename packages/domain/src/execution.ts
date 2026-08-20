import { DomainError } from "./errors";
import { classifyAttemptResult, MAX_RUNNER_FAILURE_RESCHEDULES } from "./attempt-result";
import type {
  ExecutionRun,
  ExecutionRunStatus,
  RunAttempt,
  RunAttemptStatus,
  RunBatchStatus,
} from "./run-batch";

export type AssignmentStatus =
  "pending" | "claimed" | "running" | "completed" | "cancelled" | "expired";
export type LeaseStatus = "active" | "released" | "expired" | "revoked";
export type AttemptOutcome = "succeeded" | "failed" | "timed_out" | "cancelled";

const assignmentTransitions: Readonly<Record<AssignmentStatus, readonly AssignmentStatus[]>> = {
  pending: ["claimed", "cancelled", "expired"],
  claimed: ["running", "completed", "cancelled", "expired"],
  running: ["completed", "cancelled", "expired"],
  completed: [],
  cancelled: [],
  expired: [],
};

const runTransitions: Readonly<Record<ExecutionRunStatus, readonly ExecutionRunStatus[]>> = {
  queued: ["assigned", "cancelled"],
  assigned: ["queued", "running", "succeeded", "failed", "cancelled"],
  running: ["queued", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const attemptTransitions: Readonly<Record<RunAttemptStatus, readonly RunAttemptStatus[]>> = {
  assigned: ["running", "succeeded", "failed", "timed_out", "cancelled"],
  running: ["succeeded", "failed", "timed_out", "cancelled"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
};

const leaseTransitions: Readonly<Record<LeaseStatus, readonly LeaseStatus[]>> = {
  active: ["released", "expired", "revoked"],
  released: [],
  expired: [],
  revoked: [],
};

const batchTransitions: Readonly<Record<RunBatchStatus, readonly RunBatchStatus[]>> = {
  queued: ["dispatching", "scheduled", "running", "succeeded", "failed", "cancelled"],
  dispatching: ["queued", "scheduled", "running", "succeeded", "failed", "cancelled"],
  scheduled: ["queued", "dispatching", "running", "succeeded", "failed", "cancelled"],
  running: ["queued", "dispatching", "scheduled", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function transitionAssignment(
  current: AssignmentStatus,
  next: AssignmentStatus,
): AssignmentStatus {
  if (current === next) return current;
  if (!assignmentTransitions[current].includes(next)) {
    throw new DomainError(
      "ASSIGNMENT_TRANSITION_INVALID",
      `Assignment cannot transition from ${current} to ${next}.`,
    );
  }
  return next;
}

export function transitionExecutionRun(
  current: ExecutionRunStatus,
  next: ExecutionRunStatus,
): ExecutionRunStatus {
  return transitionState("EXECUTION_RUN", runTransitions, current, next);
}

export function transitionRunAttempt(
  current: RunAttemptStatus,
  next: RunAttemptStatus,
): RunAttemptStatus {
  return transitionState("RUN_ATTEMPT", attemptTransitions, current, next);
}

export function transitionLease(current: LeaseStatus, next: LeaseStatus): LeaseStatus {
  return transitionState("LEASE", leaseTransitions, current, next);
}

export function transitionRunBatch(current: RunBatchStatus, next: RunBatchStatus): RunBatchStatus {
  return transitionState("RUN_BATCH", batchTransitions, current, next);
}

export function assertRunBatchVersion(version: number): void {
  assertPositiveVersion(version, "RunBatch");
}

export function assertExecutionRunInvariant(run: ExecutionRun): void {
  assertPositiveVersion(run.version, "ExecutionRun");
  const terminal = isTerminalRunStatus(run.status);
  if (terminal && !run.terminalOutcome) {
    throw new DomainError("EXECUTION_RUN_OUTCOME_REQUIRED", "终态 ExecutionRun 必须保存结果。");
  }
  if (!terminal && run.terminalOutcome) {
    throw new DomainError(
      "EXECUTION_RUN_OUTCOME_PREMATURE",
      "非终态 ExecutionRun 不得保存最终结果。",
    );
  }
  if (run.status === "succeeded" && run.terminalOutcome !== "succeeded") {
    throw new DomainError("EXECUTION_RUN_OUTCOME_INVALID", "成功状态必须对应成功结果。");
  }
  if (run.status === "cancelled" && run.terminalOutcome !== "cancelled") {
    throw new DomainError("EXECUTION_RUN_OUTCOME_INVALID", "取消状态必须对应取消结果。");
  }
  if (
    run.status === "failed" &&
    run.terminalOutcome !== "failed" &&
    run.terminalOutcome !== "timed_out"
  ) {
    throw new DomainError("EXECUTION_RUN_OUTCOME_INVALID", "失败状态必须对应失败或超时结果。");
  }
}

export function assertRunAttemptInvariant(attempt: RunAttempt): void {
  assertPositiveVersion(attempt.version, "RunAttempt");
  const terminal = isTerminalAttemptStatus(attempt.status);
  if (terminal && (!attempt.outcome || !attempt.finishedAt)) {
    throw new DomainError(
      "RUN_ATTEMPT_RESULT_REQUIRED",
      "终态 RunAttempt 必须保存结果和完成时间。",
    );
  }
  if (!terminal && (attempt.outcome || attempt.finishedAt)) {
    throw new DomainError("RUN_ATTEMPT_RESULT_PREMATURE", "非终态 RunAttempt 不得保存最终结果。");
  }
  if (terminal && attempt.outcome !== attempt.status) {
    throw new DomainError("RUN_ATTEMPT_OUTCOME_INVALID", "RunAttempt 状态与结果不一致。");
  }
}

export function assertActiveLease(input: {
  status: LeaseStatus;
  expiresAt: string;
  expectedVersion: number;
  actualVersion: number;
  now: string;
}): void {
  if (input.status !== "active") {
    throw new DomainError("LEASE_INACTIVE", `租约已失效（${input.status}）。`);
  }
  if (input.actualVersion !== input.expectedVersion) {
    throw new DomainError("LEASE_VERSION_CONFLICT", "租约版本已变化。");
  }
  if (input.expiresAt <= input.now) {
    throw new DomainError("LEASE_EXPIRED", "租约已过期。");
  }
}

export function outcomeAfterCompletion(input: {
  outcome: AttemptOutcome;
  attemptNumber: number;
  retryLimit: number;
  cancellationRequested: boolean;
  retryableRunnerFailure?: boolean;
  runnerFailuresBefore?: number;
  ordinaryFailuresBefore?: number;
}): { runStatus: "queued" | "succeeded" | "failed" | "cancelled"; retryScheduled: boolean } {
  if (input.outcome === "succeeded") return { runStatus: "succeeded", retryScheduled: false };
  if (input.outcome === "cancelled" || input.cancellationRequested) {
    return { runStatus: "cancelled", retryScheduled: false };
  }
  const failuresBefore = Math.max(0, input.attemptNumber - 1);
  const retryScheduled = input.retryableRunnerFailure
    ? (input.runnerFailuresBefore ?? failuresBefore) < MAX_RUNNER_FAILURE_RESCHEDULES
    : (input.ordinaryFailuresBefore ?? failuresBefore) < input.retryLimit;
  return { runStatus: retryScheduled ? "queued" : "failed", retryScheduled };
}

type BatchRunCompletion = {
  status: string;
  terminalReasonCode?: string | null;
};

// 批次终态表达执行生命周期，而不是断言结果：用例断言失败仍表示任务完整执行结束；
// 只有执行机/控制面异常才进入 failed，取消优先显示为中断。
export function aggregateBatchStatus(
  states: readonly (string | BatchRunCompletion)[],
): RunBatchStatus {
  const completions = states.map((state) =>
    typeof state === "string" ? { status: state } : state,
  );
  const statuses = completions.map((state) => state.status);
  if (statuses.length === 0) return "queued";
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "assigned")) {
    return statuses.some((status) => status === "queued") ? "dispatching" : "scheduled";
  }
  if (statuses.some((status) => status === "queued")) return "queued";
  // 用户中断是整个批次的生命周期裁决；即使中断前已有 Runner 异常，最终状态仍应
  // 清楚表达“执行中断”，异常证据继续保留在 attempt 与执行机事件中。
  if (statuses.some((status) => status === "cancelled")) return "cancelled";
  const hasAbnormalFailure = completions.some(
    ({ status, terminalReasonCode }) =>
      status === "failed" &&
      classifyAttemptResult({
        outcome: "failed",
        ...(terminalReasonCode ? { resultCode: terminalReasonCode } : {}),
      }) === "blocked",
  );
  if (hasAbnormalFailure) return "failed";
  return "succeeded";
}

export function isTerminalRunStatus(status: ExecutionRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

// 批次终态只描述生命周期是否关闭；用例断言失败也可以正常“执行完成”。完成上报据此向
// Agent 反馈 batchClosed，Agent 据此回收批次级共享输入目录。
export function isTerminalBatchStatus(status: RunBatchStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function isTerminalAttemptStatus(status: RunAttemptStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  );
}

function transitionState<TStatus extends string>(
  entity: string,
  transitions: Readonly<Record<TStatus, readonly TStatus[]>>,
  current: TStatus,
  next: TStatus,
): TStatus {
  if (current === next) return current;
  if (!transitions[current].includes(next)) {
    throw new DomainError(
      `${entity}_TRANSITION_INVALID`,
      `${entity} cannot transition from ${current} to ${next}.`,
    );
  }
  return next;
}

function assertPositiveVersion(version: number, entity: string): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError(
      `${entity.toUpperCase()}_VERSION_INVALID`,
      `${entity} 版本必须为正整数。`,
    );
  }
}
