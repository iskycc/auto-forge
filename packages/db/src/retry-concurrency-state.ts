import {
  DomainError,
  type RetryConcurrencyState,
  type RunBatchExecutionPolicy,
} from "@autoforge/domain";

export function retryConcurrencyStateFromRow(row: {
  ruleId: string;
  ruleIndex: number;
  concurrency: number;
  activatedRound: number;
}): RetryConcurrencyState {
  return {
    ruleId: row.ruleId,
    ruleIndex: row.ruleIndex,
    concurrency: row.concurrency,
    activatedRound: row.activatedRound,
  };
}

export function assertRetryConcurrencyTransition(
  policy: RunBatchExecutionPolicy | undefined,
  executionRound: number,
  state: RetryConcurrencyState,
): void {
  const rule = policy?.retryConcurrencyRules?.[state.ruleIndex];
  if (
    !rule ||
    rule.id !== state.ruleId ||
    rule.concurrency !== state.concurrency ||
    state.activatedRound !== executionRound ||
    executionRound !== rule.executionRound
  ) {
    throw new DomainError(
      "RETRY_CONCURRENCY_TRANSITION_INVALID",
      "动态重跑并发状态与批次策略快照不一致。",
    );
  }
}

export function retryConcurrencyActivationDecision(
  storedState: RetryConcurrencyState | undefined,
  batchExecutionRound: number,
  input: {
    executionRound: number;
    expectedRuleId: string | null;
    state: RetryConcurrencyState;
  },
):
  | { outcome: "activate" }
  | { outcome: "stale" }
  | { outcome: "unchanged"; state: RetryConcurrencyState } {
  if (batchExecutionRound !== input.executionRound) return { outcome: "stale" };
  if (storedState?.ruleId !== (input.expectedRuleId ?? undefined)) {
    return storedState ? { outcome: "unchanged", state: storedState } : { outcome: "stale" };
  }
  if (
    storedState &&
    (input.executionRound <= storedState.activatedRound ||
      input.state.ruleIndex <= storedState.ruleIndex)
  ) {
    return { outcome: "unchanged", state: storedState };
  }
  return { outcome: "activate" };
}
