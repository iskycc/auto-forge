import { describe, expect, it } from "vitest";
import {
  outcomeAfterCompletion,
  parseRecoveryRounds,
  retryCompletionForRound,
  roundNeedsCompleteStatistics,
} from "../src";

describe("unlimited retries and round completion", () => {
  it("accepts explicit recovery rounds and rejects expressions, duplicates and invalid numbers", () => {
    expect(parseRecoveryRounds(" 13,7,10 ")).toEqual([7, 10, 13]);
    for (const value of [
      "8*9",
      "7,,10",
      "0",
      "-1",
      "1.5",
      "7,7",
      "7,",
      "1e3",
      "9007199254740992",
      "7，10",
    ])
      expect(() => parseRecoveryRounds(value)).toThrow();
  });
  it("retries ordinary failures without a count ceiling, preserving cancellation and runner failure limits", () => {
    const input = {
      outcome: "failed" as const,
      attemptNumber: 41,
      retryLimit: 0,
      unlimitedRetries: true,
      cancellationRequested: false,
    };
    expect(outcomeAfterCompletion(input).retryScheduled).toBe(true);
    expect(outcomeAfterCompletion({ ...input, retrySuppressed: true }).retryScheduled).toBe(false);
    expect(outcomeAfterCompletion({ ...input, cancellationRequested: true }).runStatus).toBe(
      "cancelled",
    );
    expect(
      outcomeAfterCompletion({ ...input, retryableRunnerFailure: true, runnerFailuresBefore: 100 })
        .retryScheduled,
    ).toBe(false);
    expect(outcomeAfterCompletion({ ...input, outcome: "succeeded" }).runStatus).toBe("succeeded");
  });
  it("evaluates exact round boundaries, strict comparisons and cumulative versus per-round rates", () => {
    const rule = {
      id: "stop",
      afterRound: 10,
      metric: "remainingRuns" as const,
      operator: "gt" as const,
      value: 1000,
    };
    const statistics = {
      round: 10,
      totalRuns: 2000,
      succeededRuns: 999,
      roundRuns: 1100,
      roundSucceeded: 99,
      remainingRuns: 1001,
    };
    expect(retryCompletionForRound([rule], statistics)?.round).toBe(10);
    expect(retryCompletionForRound([rule], { ...statistics, round: 9 })).toBeUndefined();
    expect(retryCompletionForRound([rule], { ...statistics, remainingRuns: 1000 })).toBeUndefined();
    expect(
      retryCompletionForRound(
        [{ ...rule, metric: "cumulativePassRate", operator: "gte", value: 49.95 }],
        statistics,
      ),
    ).toBeDefined();
    expect(
      retryCompletionForRound(
        [{ ...rule, metric: "roundPassRate", operator: "lt", value: 10 }],
        statistics,
      ),
    ).toBeDefined();
    expect(roundNeedsCompleteStatistics(JSON.stringify({ retryStopRules: [rule] }), 11)).toBe(true);
    expect(roundNeedsCompleteStatistics(JSON.stringify({ retryStopRules: [rule] }), 12)).toBe(
      false,
    );
  });
});
