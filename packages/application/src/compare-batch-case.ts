export type BatchCaseVariant = {
  displayName: string;
  className: string;
  version: number;
  outcome?: string | undefined;
  attemptId?: string | undefined;
  attemptNumber?: number | undefined;
  durationMs?: number | undefined;
};

/** The API and persisted comparison use the same missing-case and duration semantics. */
export function compareBatchCase(
  caseDefinitionId: string,
  left?: BatchCaseVariant,
  right?: BatchCaseVariant,
) {
  return {
    caseDefinitionId,
    displayName: left?.displayName ?? right?.displayName ?? caseDefinitionId,
    className: left?.className ?? right?.className ?? caseDefinitionId,
    ...(left ? { leftVersion: left.version } : {}),
    ...(right ? { rightVersion: right.version } : {}),
    ...(left?.outcome ? { leftOutcome: left.outcome } : {}),
    ...(right?.outcome ? { rightOutcome: right.outcome } : {}),
    ...(left?.attemptId ? { leftAttemptId: left.attemptId } : {}),
    ...(right?.attemptId ? { rightAttemptId: right.attemptId } : {}),
    ...(left?.attemptNumber ? { leftAttemptNumber: left.attemptNumber } : {}),
    ...(right?.attemptNumber ? { rightAttemptNumber: right.attemptNumber } : {}),
    ...(left?.durationMs === undefined ? {} : { leftDurationMs: left.durationMs }),
    ...(right?.durationMs === undefined ? {} : { rightDurationMs: right.durationMs }),
    ...(left?.durationMs === undefined || right?.durationMs === undefined
      ? {}
      : { durationDeltaMs: right.durationMs - left.durationMs }),
  };
}
