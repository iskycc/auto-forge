export type BatchCaseVariant = {
  displayName: string;
  version: number;
  outcome?: string | undefined;
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
    ...(left ? { leftVersion: left.version } : {}),
    ...(right ? { rightVersion: right.version } : {}),
    ...(left?.outcome ? { leftOutcome: left.outcome } : {}),
    ...(right?.outcome ? { rightOutcome: right.outcome } : {}),
    ...(left?.durationMs === undefined ? {} : { leftDurationMs: left.durationMs }),
    ...(right?.durationMs === undefined ? {} : { rightDurationMs: right.durationMs }),
    ...(left?.durationMs === undefined || right?.durationMs === undefined
      ? {}
      : { durationDeltaMs: right.durationMs - left.durationMs }),
  };
}
