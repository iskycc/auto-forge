import { describe, expect, it } from "vitest";

import {
  normalizeStoredRetryConcurrencyRules,
  retryConcurrencyDecisionForRound,
  retryConcurrencyForRound,
  type RetryConcurrencyRule,
} from "../src/case-suite";

const rules: RetryConcurrencyRule[] = [
  {
    id: "high-pass",
    executionRound: 2,
    previousRoundPassRateMinimum: 70,
    concurrency: 40,
  },
  {
    id: "small-remainder",
    executionRound: 4,
    remainingRunsMaximum: 20,
    concurrency: 10,
  },
];

describe("retryConcurrencyForRound", () => {
  it("maps a stored legacy range to its start round", () => {
    expect(
      normalizeStoredRetryConcurrencyRules([
        {
          id: "legacy",
          executionRoundFrom: 3,
          executionRoundTo: 8,
          previousRoundPassRateMinimum: 70,
          concurrency: 40,
        },
      ]),
    ).toEqual([
      {
        id: "legacy",
        executionRound: 3,
        previousRoundPassRateMinimum: 70,
        concurrency: 40,
      },
    ]);
  });

  it("only evaluates a rule in its configured execution round", () => {
    expect(
      retryConcurrencyForRound(100, rules, {
        executionRound: 3,
        previousRoundPassRate: 80,
        remainingRuns: 50,
      }),
    ).toBe(100);
  });

  it("keeps an activated concurrency when the same condition misses in later rounds", () => {
    const activated = retryConcurrencyDecisionForRound(100, rules, {
      executionRound: 2,
      previousRoundPassRate: 75,
      remainingRuns: 80,
    });

    expect(activated.transition).toEqual({
      ruleId: "high-pass",
      ruleIndex: 0,
      concurrency: 40,
      activatedRound: 2,
    });
    expect(
      retryConcurrencyForRound(
        100,
        rules,
        { executionRound: 5, previousRoundPassRate: 60, remainingRuns: 50 },
        activated.activeState,
      ),
    ).toBe(40);
  });

  it("allows a later rule to switch concurrency and keeps the newest stage", () => {
    const highPassState = {
      ruleId: "high-pass",
      ruleIndex: 0,
      concurrency: 40,
      activatedRound: 2,
    };
    const switched = retryConcurrencyDecisionForRound(
      100,
      rules,
      { executionRound: 4, previousRoundPassRate: 60, remainingRuns: 20 },
      highPassState,
    );

    expect(switched.transition).toEqual({
      ruleId: "small-remainder",
      ruleIndex: 1,
      concurrency: 10,
      activatedRound: 4,
    });
    expect(
      retryConcurrencyForRound(
        100,
        rules,
        { executionRound: 6, previousRoundPassRate: 90, remainingRuns: 50 },
        switched.activeState,
      ),
    ).toBe(10);
  });

  it("does not revisit a missed one-time trigger in later rounds", () => {
    expect(
      retryConcurrencyDecisionForRound(100, rules, {
        executionRound: 3,
        previousRoundPassRate: 80,
        remainingRuns: 20,
      }).transition,
    ).toBeUndefined();
  });

  it("does not match pass-rate conditions until a previous rate exists", () => {
    expect(
      retryConcurrencyForRound(100, rules, {
        executionRound: 2,
        previousRoundPassRate: null,
        remainingRuns: 50,
      }),
    ).toBe(100);
  });
});
