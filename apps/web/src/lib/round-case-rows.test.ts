import type { ExecutionRun, RunAttempt } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import {
  buildRoundCaseRows,
  canCancelRoundCaseRow,
  compareRoundCaseRowsByStatus,
} from "./round-case-rows";

function run(id: string, overrides: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id,
    batchId: "batch-1",
    caseDefinitionId: `case-${id}`,
    caseVersion: 1,
    displayName: `${id}#method`,
    className: `com.example.${id}`,
    status: "queued",
    attemptCount: 0,
    version: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function attempt(
  id: string,
  executionRunId: string,
  attemptNumber: number,
  outcome: NonNullable<RunAttempt["outcome"]>,
): RunAttempt {
  return {
    id,
    executionRunId,
    runnerId: "runner-1",
    attemptNumber,
    status: outcome,
    schedulingScore: 1,
    version: 1,
    outcome,
    createdAt: "2026-08-17T00:00:30.000Z",
  };
}

describe("buildRoundCaseRows", () => {
  // run-a 第 1 轮通过；run-b 第 1 轮失败、等待第 2 轮；run-c 尚未产生任何 attempt。
  const batch = {
    currentRound: 1,
    runs: [run("run-a"), run("run-b", { heldRound: 2 }), run("run-c")],
    attempts: [
      attempt("attempt-a1", "run-a", 1, "succeeded"),
      attempt("attempt-b1", "run-b", 1, "failed"),
    ],
  };

  it("keeps every run in the first round", () => {
    const rows = buildRoundCaseRows(batch, 1);
    expect(rows.map((row) => row.run.id)).toEqual(["run-a", "run-b", "run-c"]);
    expect(rows.find((row) => row.run.id === "run-c")?.attempt).toBeUndefined();
  });

  it("excludes runs already passed in earlier rounds from later rounds", () => {
    const rows = buildRoundCaseRows(batch, 2);
    // 第 2 轮只包含首轮失败的 run-b；首轮通过或尚未执行的用例都不属于重跑总数。
    expect(rows.map((row) => row.run.id)).toEqual(["run-b"]);
    expect(rows[0]?.attempt).toBeUndefined();
    expect(rows[0]?.round).toBe(2);
  });

  it("keeps an actual later attempt visible even if historical data is inconsistent", () => {
    const rerun = {
      ...batch,
      attempts: [...batch.attempts, attempt("attempt-a2", "run-a", 2, "failed")],
    };
    const rows = buildRoundCaseRows(rerun, 2);
    expect(rows.find((candidate) => candidate.run.id === "run-a")?.attempt?.id).toBe("attempt-a2");
  });

  it("emits one row per attempt in all-rounds view, ordered by round", () => {
    const multi = {
      ...batch,
      currentRound: 2,
      attempts: [attempt("attempt-b2", "run-b", 2, "succeeded"), ...batch.attempts],
    };
    const rows = buildRoundCaseRows(multi, "all");
    expect(
      rows.map((row) => `${row.run.id}:${row.round}:${row.attempt?.attemptNumber ?? "none"}`),
    ).toEqual(["run-a:1:1", "run-b:1:1", "run-b:2:2", "run-c:1:none"]);
  });

  it("emits a pending all-rounds row for an eligible retry that has not started", () => {
    const rows = buildRoundCaseRows({ ...batch, currentRound: 2 }, "all");
    expect(
      rows.map((row) => `${row.run.id}:${row.round}:${row.attempt ? "done" : "pending"}`),
    ).toEqual(["run-a:1:done", "run-b:1:done", "run-b:2:pending", "run-c:1:pending"]);
  });

  it("emits one final summary row per initial case using any success or the latest failure", () => {
    const summaryBatch = {
      ...batch,
      currentRound: 3,
      attempts: [
        ...batch.attempts,
        attempt("attempt-b2", "run-b", 2, "failed"),
        attempt("attempt-b3", "run-b", 3, "succeeded"),
      ],
    };

    const rows = buildRoundCaseRows(summaryBatch, "summary");

    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.run.id === "run-a")?.attempt?.id).toBe("attempt-a1");
    expect(rows.find((row) => row.run.id === "run-b")?.attempt?.id).toBe("attempt-b3");
    expect(rows.find((row) => row.run.id === "run-c")?.attempt).toBeUndefined();
  });

  it("does not offer cancellation on terminal attempts even if the run is queued for retry", () => {
    const failedAttempt = batch.attempts.find((candidate) => candidate.executionRunId === "run-b");
    expect(failedAttempt).toBeDefined();
    expect(canCancelRoundCaseRow({ run: batch.runs[1]!, attempt: failedAttempt, round: 1 })).toBe(
      false,
    );
    expect(canCancelRoundCaseRow({ run: batch.runs[1]!, attempt: undefined, round: 2 })).toBe(true);
  });
});

describe("compareRoundCaseRowsByStatus", () => {
  it("orders failed rows by their error description instead of their case name", () => {
    const first = {
      run: run("z-case"),
      round: 1,
      attempt: {
        ...attempt("attempt-z", "z-case", 1, "failed"),
        resultCode: "TESTNG_ASSERTIONS_FAILED",
        resultSummary: "AssertionError: alpha failure",
      },
    };
    const second = {
      run: run("a-case"),
      round: 1,
      attempt: {
        ...attempt("attempt-a", "a-case", 1, "failed"),
        resultCode: "TESTNG_ASSERTIONS_FAILED",
        resultSummary: "AssertionError: zeta failure",
      },
    };

    expect(compareRoundCaseRowsByStatus(first, second)).toBeLessThan(0);
  });

  it("keeps the status category as the primary sort key", () => {
    const succeeded = {
      run: run("succeeded"),
      round: 1,
      attempt: attempt("attempt-succeeded", "succeeded", 1, "succeeded"),
    };
    const failed = {
      run: run("failed"),
      round: 1,
      attempt: attempt("attempt-failed", "failed", 1, "failed"),
    };

    expect(compareRoundCaseRowsByStatus(succeeded, failed)).toBeLessThan(0);
  });
});
