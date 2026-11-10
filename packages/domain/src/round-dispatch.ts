import { normalizeStoredRetryConcurrencyRules } from "./case-suite";

export const RETRY_CONCURRENCY_RESULT_FIELDS = [
  "previousRoundPassRateMinimum",
  "previousRoundPassRateMaximum",
  "remainingRunsMinimum",
  "remainingRunsMaximum",
] as const;

export type RoundDispatchState = {
  currentRound: number;
  nextHeldRound: number | null;
  oldestActiveRound: number | null;
  hasQueuedWork: boolean;
  requiresCompletedRound: boolean;
};

/** Two overlapping rounds share the smaller cap until the older round finishes all retries. */
export function roundWindowConcurrency(
  currentConcurrency: number | undefined,
  overlappingConcurrency: number | null | undefined,
): number | undefined {
  if (overlappingConcurrency == null) return currentConcurrency;
  return Math.min(currentConcurrency ?? Number.POSITIVE_INFINITY, overlappingConcurrency);
}

/** The latest opened round may overlap only its immediate predecessor. */
export function roundDispatchTarget(state: RoundDispatchState): number | null {
  const { currentRound, nextHeldRound, oldestActiveRound } = state;
  if (nextHeldRound === null) return null;
  // A late failure must join an already opened round before the window can move.
  if (nextHeldRound <= currentRound) return currentRound;
  if (state.hasQueuedWork || nextHeldRound !== currentRound + 1) return null;
  if (oldestActiveRound !== null && oldestActiveRound < currentRound) return null;
  if (state.requiresCompletedRound && oldestActiveRound !== null) return null;
  return nextHeldRound;
}

export function roundNeedsCompleteStatistics(
  policyJson: string | null,
  nextRound: number,
): boolean {
  const policy = JSON.parse(policyJson ?? "{}") as { retryConcurrencyRules?: unknown } | null;
  return normalizeStoredRetryConcurrencyRules(policy?.retryConcurrencyRules).some(
    (rule) =>
      rule.executionRound === nextRound &&
      RETRY_CONCURRENCY_RESULT_FIELDS.some((field) => rule[field] !== undefined),
  );
}
