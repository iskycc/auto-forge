/** Explicit deep links are retained; ordinary entry always starts from the final-result summary. */
export function executionRoundSelection(
  requested: string | null,
  rounds: readonly number[],
  recoveryRounds: readonly number[],
): string {
  if (!requested) return "summary";
  if (requested === "summary" || requested === "all") return requested;
  if (rounds.some((round) => String(round) === requested)) return requested;
  if (recoveryRounds.some((round) => `recovery-${round}` === requested)) return requested;
  return "summary";
}
