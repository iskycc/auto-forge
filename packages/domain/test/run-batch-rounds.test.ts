import { describe, expect, it } from "vitest";

import type { ExecutionRun, RunAttempt, RunBatch } from "../src/run-batch";
import {
  summarizeAllRunBatchRounds,
  summarizeRunBatchFinalResults,
  summarizeRunBatchRounds,
} from "../src/run-batch";

describe("summarizeRunBatchRounds", () => {
  it("aggregates multiple rounds in round mode", () => {
    const batch = makeBatch({ retryMode: "round", retryLimit: 2, currentRound: 3, totalRuns: 3 });
    const runs = [
      makeRun("run-1"),
      makeRun("run-2"),
      makeRun("run-3", { heldRound: 3, status: "queued" }),
    ];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "succeeded"),
      makeAttempt("a2", "run-2", 1, "failed"),
      makeAttempt("a3", "run-3", 1, "failed"),
      makeAttempt("a4", "run-2", 2, "succeeded", {
        startedAt: "2026-08-10T00:10:00.000Z",
        finishedAt: "2026-08-10T00:12:00.000Z",
      }),
      makeAttempt("a5", "run-3", 2, "failed", {
        startedAt: "2026-08-10T00:11:00.000Z",
        finishedAt: "2026-08-10T00:13:00.000Z",
      }),
    ];

    const summaries = summarizeRunBatchRounds(batch, runs, attempts);

    expect(summaries.map((summary) => summary.round)).toEqual([1, 2, 3]);
    const [first, second, third] = summaries;
    expect(first).toMatchObject({
      status: "completed",
      totalRuns: 3,
      executed: 3,
      passed: 1,
      failed: 2,
      timedOut: 0,
      cancelled: 0,
      notExecuted: 0,
      roundPassRate: 33,
      overallPassRate: 33,
      startedAt: "2026-08-10T00:00:00.000Z",
      durationMs: 60_000,
    });
    expect(second).toMatchObject({
      status: "completed",
      totalRuns: 2,
      executed: 2,
      passed: 1,
      failed: 1,
      notExecuted: 0,
      roundPassRate: 50,
      // run-1 与 run-2 截至第二轮均已通过。
      overallPassRate: 67,
      startedAt: "2026-08-10T00:10:00.000Z",
      durationMs: 180_000,
    });
    expect(third).toMatchObject({
      status: "waiting",
      totalRuns: 1,
      executed: 0,
      notExecuted: 1,
      roundPassRate: null,
      overallPassRate: 67,
      startedAt: null,
      durationMs: null,
    });
  });

  it("reports not-yet-attempted eligible cases while a round is running", () => {
    const batch = makeBatch({ retryMode: "round", retryLimit: 2, currentRound: 2, totalRuns: 3 });
    const runs = [makeRun("run-1"), makeRun("run-2"), makeRun("run-3")];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "succeeded"),
      makeAttempt("a2", "run-2", 1, "failed"),
      makeAttempt("a3", "run-3", 1, "timed_out"),
      makeAttempt("a4", "run-2", 2, undefined, { status: "running" }),
    ];

    const summaries = summarizeRunBatchRounds(batch, runs, attempts);
    const running = summaries.find((summary) => summary.round === 2);

    expect(running?.status).toBe("running");
    expect(running?.totalRuns).toBe(2);
    expect(running?.executed).toBe(1);
    expect(running?.notExecuted).toBe(1);
    expect(running?.durationMs).toBeNull();
  });

  it("excludes running attempts from the current-round pass-rate denominator", () => {
    const batch = makeBatch({ currentRound: 1, totalRuns: 2 });
    const runs = [makeRun("run-1"), makeRun("run-2")];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "succeeded"),
      makeAttempt("a2", "run-2", 1, undefined, { status: "running" }),
    ];

    const [summary] = summarizeRunBatchRounds(batch, runs, attempts);

    expect(summary).toMatchObject({
      executed: 2,
      passed: 1,
      roundPassRate: 100,
      status: "running",
    });
  });

  it("keeps an incomplete current round live after all existing attempts finish", () => {
    const batch = makeBatch({ currentRound: 1, totalRuns: 3 });
    const runs = [makeRun("run-1"), makeRun("run-2"), makeRun("run-3")];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "succeeded"),
      makeAttempt("a2", "run-2", 1, "failed"),
    ];

    const [first] = summarizeRunBatchRounds(batch, runs, attempts);

    expect(first).toMatchObject({
      status: "running",
      totalRuns: 3,
      executed: 2,
      notExecuted: 1,
      durationMs: null,
    });
  });

  it("keeps a future retry round waiting and derives its total from the previous failures", () => {
    const batch = makeBatch({ retryMode: "round", retryLimit: 2, currentRound: 2, totalRuns: 3 });
    const runs = [
      makeRun("run-1"),
      makeRun("run-2", { heldRound: 3, status: "queued" }),
      makeRun("run-3"),
    ];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "succeeded"),
      makeAttempt("a2", "run-2", 1, "failed"),
      makeAttempt("a3", "run-3", 1, "failed"),
      makeAttempt("a4", "run-2", 2, "failed"),
      makeAttempt("a5", "run-3", 2, undefined, { status: "running" }),
    ];

    const third = summarizeRunBatchRounds(batch, runs, attempts).find(
      (summary) => summary.round === 3,
    );

    expect(third).toMatchObject({
      status: "waiting",
      totalRuns: 1,
      executed: 0,
      notExecuted: 1,
    });
  });

  it("distinguishes timed_out from failed and counts cancellations", () => {
    const batch = makeBatch({ totalRuns: 3 });
    const runs = [makeRun("run-1"), makeRun("run-2"), makeRun("run-3")];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "timed_out"),
      makeAttempt("a2", "run-2", 1, "failed"),
      makeAttempt("a3", "run-3", 1, "cancelled"),
    ];

    const [first] = summarizeRunBatchRounds(batch, runs, attempts);

    expect(first).toMatchObject({
      status: "completed",
      executed: 3,
      passed: 0,
      failed: 1,
      timedOut: 1,
      cancelled: 1,
      roundPassRate: 0,
      overallPassRate: 0,
    });
  });

  it("treats attemptNumber as the retry sequence in immediate mode", () => {
    const batch = makeBatch({ retryMode: "immediate", retryLimit: 1, totalRuns: 1 });
    const runs = [makeRun("run-1")];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "failed"),
      makeAttempt("a2", "run-1", 2, "succeeded", {
        startedAt: "2026-08-10T00:05:00.000Z",
        finishedAt: "2026-08-10T00:06:00.000Z",
      }),
    ];

    const summaries = summarizeRunBatchRounds(batch, runs, attempts);

    expect(summaries.map((summary) => summary.round)).toEqual([1, 2]);
    expect(summaries[0]).toMatchObject({ executed: 1, passed: 0, overallPassRate: 0 });
    expect(summaries[1]).toMatchObject({
      status: "completed",
      executed: 1,
      passed: 1,
      roundPassRate: 100,
      overallPassRate: 100,
      durationMs: 60_000,
    });
  });

  it("returns a single waiting round when no attempts exist", () => {
    const batch = makeBatch({ status: "queued", totalRuns: 2 });
    const runs = [makeRun("run-1"), makeRun("run-2")];

    const summaries = summarizeRunBatchRounds(batch, runs, []);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      round: 1,
      status: "waiting",
      totalRuns: 2,
      executed: 0,
      notExecuted: 2,
      roundPassRate: null,
      overallPassRate: 0,
      startedAt: null,
      durationMs: null,
    });
  });

  it("sums every round for the all-rounds totals", () => {
    const batch = makeBatch({ retryMode: "round", retryLimit: 1, currentRound: 2, totalRuns: 3 });
    const runs = [makeRun("run-1"), makeRun("run-2"), makeRun("run-3")];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "succeeded"),
      makeAttempt("a2", "run-2", 1, "failed"),
      makeAttempt("a3", "run-3", 1, "timed_out"),
      makeAttempt("a4", "run-2", 2, "succeeded"),
    ];

    const all = summarizeAllRunBatchRounds(summarizeRunBatchRounds(batch, runs, attempts));

    expect(all).toEqual({
      totalRuns: 5,
      passed: 2,
      failed: 1,
      timedOut: 1,
      cancelled: 0,
      notExecuted: 1,
      passRate: 40,
    });
  });

  it("summarizes final case outcomes without counting retry attempts as extra cases", () => {
    const batch = makeBatch({ retryMode: "round", retryLimit: 2, currentRound: 3, totalRuns: 3 });
    const runs = [makeRun("run-1"), makeRun("run-2"), makeRun("run-3")];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "succeeded"),
      makeAttempt("a2", "run-2", 1, "failed"),
      makeAttempt("a3", "run-3", 1, "failed"),
      makeAttempt("a4", "run-2", 2, "succeeded"),
      makeAttempt("a5", "run-3", 2, "failed"),
      makeAttempt("a6", "run-3", 3, "timed_out"),
    ];

    expect(summarizeRunBatchFinalResults(batch, runs, attempts)).toEqual({
      totalRuns: 3,
      passed: 2,
      failed: 0,
      timedOut: 1,
      cancelled: 0,
      notExecuted: 0,
      passRate: 67,
    });
  });

  it("falls back to createdAt when an attempt never reported startedAt", () => {
    const batch = makeBatch({ totalRuns: 1 });
    const runs = [makeRun("run-1")];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "succeeded", {
        startedAt: undefined,
        finishedAt: "2026-08-10T00:03:00.000Z",
      }),
    ];

    const [first] = summarizeRunBatchRounds(batch, runs, attempts);

    expect(first?.startedAt).toBe("2026-08-10T00:00:00.000Z");
    expect(first?.durationMs).toBe(180_000);
  });
});

function makeBatch(overrides: Partial<RunBatch>): RunBatch {
  return {
    id: "batch-1",
    projectId: "project-1",
    suiteId: "suite-1",
    suiteName: "每日冒烟",
    suiteVersion: 1,
    status: "running",
    priority: 0,
    retryLimit: 0,
    retryMode: "round",
    currentRound: 1,
    queueTimeoutMs: 86_400_000,
    claimTimeoutMs: 300_000,
    executionTimeoutMs: 3_600_000,
    uploadTimeoutMs: 600_000,
    environmentVariables: [],
    secretBindings: [],
    selectedRunnerIds: ["runner-1"],
    totalRuns: 1,
    queuedRuns: 0,
    assignedRuns: 0,
    runningRuns: 1,
    succeededRuns: 0,
    failedRuns: 0,
    timedOutRuns: 0,
    cancelledRuns: 0,
    version: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(id: string, overrides: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id,
    batchId: "batch-1",
    caseDefinitionId: `case-${id}`,
    caseVersion: 1,
    displayName: `用例 ${id}`,
    className: `example.${id}Test`,
    status: "running",
    attemptCount: 1,
    version: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeAttempt(
  id: string,
  executionRunId: string,
  attemptNumber: number,
  outcome: RunAttempt["outcome"],
  overrides: Partial<RunAttempt> = {},
): RunAttempt {
  return {
    id,
    executionRunId,
    runnerId: "runner-1",
    attemptNumber,
    status: overrides.status ?? outcome ?? "running",
    schedulingScore: 0,
    version: 1,
    startedAt: "2026-08-10T00:00:00.000Z",
    finishedAt: outcome ? "2026-08-10T00:01:00.000Z" : undefined,
    outcome,
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}
