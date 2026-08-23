import { describe, expect, it } from "vitest";

import { retryConcurrencyForRound, type RetryConcurrencyRule } from "../src/case-suite";

const rules: RetryConcurrencyRule[] = [
  {
    id: "low-pass-small-remainder",
    executionRoundFrom: 2,
    executionRoundTo: 5,
    previousRoundPassRateMaximum: 20,
    remainingRunsMinimum: 50,
    remainingRunsMaximum: 50,
    concurrency: 10,
  },
  {
    id: "third-round",
    executionRoundFrom: 3,
    executionRoundTo: 3,
    concurrency: 20,
  },
];

describe("retryConcurrencyForRound", () => {
  it("uses the first rule matching round, previous pass rate and remaining runs", () => {
    expect(
      retryConcurrencyForRound(40, rules, {
        executionRound: 3,
        previousRoundPassRate: 20,
        remainingRuns: 50,
      }),
    ).toBe(10);
  });

  it("matches a round-only rule and otherwise falls back to base concurrency", () => {
    expect(
      retryConcurrencyForRound(40, rules, {
        executionRound: 3,
        previousRoundPassRate: 80,
        remainingRuns: 6,
      }),
    ).toBe(20);
    expect(
      retryConcurrencyForRound(40, rules, {
        executionRound: 4,
        previousRoundPassRate: 80,
        remainingRuns: 6,
      }),
    ).toBe(40);
  });

  it("does not match pass-rate conditions until a previous rate exists", () => {
    expect(
      retryConcurrencyForRound(40, rules, {
        executionRound: 2,
        previousRoundPassRate: null,
        remainingRuns: 50,
      }),
    ).toBe(40);
  });
});
