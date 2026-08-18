import type { ExecutionRun, RunAttempt } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { buildRoundCaseRows } from "./round-case-rows";

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
    // run-a 第 1 轮已通过，第 2 轮不再出现；run-b 等待第 2 轮，显示为未执行占位。
    expect(rows.map((row) => row.run.id)).toEqual(["run-b", "run-c"]);
    expect(rows[0]?.attempt).toBeUndefined();
  });

  it("excludes previously passed runs even when stale data holds a later attempt", () => {
    const rerun = {
      ...batch,
      attempts: [...batch.attempts, attempt("attempt-a2", "run-a", 2, "failed")],
    };
    const rows = buildRoundCaseRows(rerun, 2);
    // 调度语义上已通过用例不会重跑；即使历史数据残留后续 attempt，也不再显示为未执行。
    expect(rows.some((candidate) => candidate.run.id === "run-a")).toBe(false);
  });

  it("emits one row per attempt in all-rounds view, ordered by round", () => {
    const multi = {
      ...batch,
      attempts: [attempt("attempt-b2", "run-b", 2, "succeeded"), ...batch.attempts],
    };
    const rows = buildRoundCaseRows(multi, "all");
    expect(rows.map((row) => `${row.run.id}:${row.attempt?.attemptNumber ?? "none"}`)).toEqual([
      "run-a:1",
      "run-b:1",
      "run-b:2",
      "run-c:none",
    ]);
  });
});
