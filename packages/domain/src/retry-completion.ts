import { DomainError } from "./errors";

export type RetryStopRule = {
  id: string;
  afterRound: number;
  metric: "remainingRuns" | "cumulativePassRate" | "roundPassRate";
  operator: "gt" | "gte" | "lt" | "lte";
  value: number;
};

export type RetryCompletion = { round: number; ruleId: string; reason: string };

/** Round lists are explicit boundaries, never expressions or ranges. */
export function parseRecoveryRounds(input: string): number[] {
  if (!/^\s*[1-9]\d*\s*(,\s*[1-9]\d*\s*)*$/.test(input)) {
    throw new DomainError(
      "RECOVERY_ROUNDS_INVALID",
      "恢复轮次请填写正整数，多个轮次用英文逗号分隔，例如 7,10,13。",
    );
  }
  const rounds = input.split(",").map((value) => Number(value.trim()));
  if (
    rounds.some((round) => !Number.isSafeInteger(round)) ||
    new Set(rounds).size !== rounds.length
  ) {
    throw new DomainError("RECOVERY_ROUNDS_INVALID", "恢复轮次必须是有效且不重复的正整数。");
  }
  return rounds.sort((left, right) => left - right);
}

export function recoveryRounds(rule: { afterRound: number; afterRounds?: number[] }): number[] {
  return rule.afterRounds ?? [rule.afterRound];
}

export function retryCompletionForRound(
  rules: readonly RetryStopRule[],
  statistics: {
    round: number;
    totalRuns: number;
    succeededRuns: number;
    roundRuns: number;
    roundSucceeded: number;
    remainingRuns: number;
  },
): RetryCompletion | undefined {
  const metrics = {
    remainingRuns: statistics.remainingRuns,
    cumulativePassRate:
      statistics.totalRuns === 0 ? 0 : (statistics.succeededRuns * 100) / statistics.totalRuns,
    roundPassRate:
      statistics.roundRuns === 0 ? 0 : (statistics.roundSucceeded * 100) / statistics.roundRuns,
  };
  const labels = {
    remainingRuns: "剩余未通过用例数",
    cumulativePassRate: "累计通过率",
    roundPassRate: "本轮通过率",
  };
  const operators = { gt: ">", gte: "≥", lt: "<", lte: "≤" };
  for (const rule of rules) {
    if (rule.afterRound !== statistics.round) continue;
    const actual = metrics[rule.metric];
    const matches =
      rule.operator === "gt"
        ? actual > rule.value
        : rule.operator === "gte"
          ? actual >= rule.value
          : rule.operator === "lt"
            ? actual < rule.value
            : actual <= rule.value;
    if (matches)
      return {
        round: statistics.round,
        ruleId: rule.id,
        reason: `第 ${statistics.round} 轮完成后，${labels[rule.metric]} ${actual.toLocaleString("en-US", { maximumFractionDigits: 2 })}${rule.metric === "remainingRuns" ? "" : "%"} ${operators[rule.operator]} ${rule.value}${rule.metric === "remainingRuns" ? "" : "%"}，按条件结束执行。`,
      };
  }
  return undefined;
}
