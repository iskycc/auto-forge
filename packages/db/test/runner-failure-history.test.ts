import { describe, expect, it } from "vitest";

import type { RunAttempt } from "@autoforge/domain";

import { runnerHistoryIdsByExecutionRun } from "../src/runner-failure-history";

describe("Runner scheduling history", () => {
  it("groups Runner ids by run in attempt order regardless of database row order", () => {
    const attempts = [
      attempt("attempt-3", "run-a", "runner-c", 3),
      attempt("attempt-1", "run-a", "runner-a", 1),
      attempt("attempt-b", "run-b", "runner-b", 1),
      attempt("attempt-2", "run-a", "runner-b", 2),
    ];

    expect(runnerHistoryIdsByExecutionRun(attempts)).toEqual({
      "run-a": ["runner-a", "runner-b", "runner-c"],
      "run-b": ["runner-b"],
    });
  });
});

function attempt(
  id: string,
  executionRunId: string,
  runnerId: string,
  attemptNumber: number,
): RunAttempt {
  return {
    id,
    executionRunId,
    runnerId,
    attemptNumber,
    status: "failed",
    schedulingScore: 1,
    version: 1,
    createdAt: `2026-08-30T00:00:0${attemptNumber}.000Z`,
  };
}
