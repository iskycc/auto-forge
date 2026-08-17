import { describe, expect, it } from "vitest";

import type { ExecutionRun, RunAttempt, RunBatch } from "../src/run-batch";
import { summarizeRunBatchRounds } from "../src/run-batch";

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
      blocked: 0,
      roundPassRate: 33,
      overallPassRate: 33,
      startedAt: "2026-08-10T00:00:00.000Z",
      durationMs: 60_000,
    });
    expect(second).toMatchObject({
      status: "completed",
      executed: 2,
      passed: 1,
      failed: 1,
      roundPassRate: 50,
      // run-1 与 run-2 截至第二轮均已通过。
      overallPassRate: 67,
      startedAt: "2026-08-10T00:10:00.000Z",
      durationMs: 180_000,
    });
    expect(third).toMatchObject({
      status: "waiting",
      executed: 0,
      roundPassRate: null,
      overallPassRate: 67,
      startedAt: null,
      durationMs: null,
    });
  });

  it("counts held runs as blocked on waiting and running rounds", () => {
    const batch = makeBatch({ retryMode: "round", retryLimit: 2, currentRound: 2, totalRuns: 3 });
    const runs = [
      makeRun("run-1"),
      makeRun("run-2", { heldRound: 3, status: "queued" }),
      makeRun("run-3", { heldRound: 3, status: "queued" }),
    ];
    const attempts = [
      makeAttempt("a1", "run-1", 1, "succeeded"),
      makeAttempt("a2", "run-2", 1, "failed"),
      makeAttempt("a3", "run-3", 1, "timed_out"),
      // 第二轮只有 run-1 无重跑需求；此处用一个进行中的 attempt 表示轮次仍在执行。
      makeAttempt("a4", "run-1", 2, undefined, { status: "running" }),
    ];

    const summaries = summarizeRunBatchRounds(batch, runs, attempts);
    const waiting = summaries.find((summary) => summary.round === 3);
    const running = summaries.find((summary) => summary.round === 2);

    expect(running?.status).toBe("running");
    // run-2、run-3 在第二轮没有 attempt 且 heldRound=3，对进行中的第二轮算 blocked。
    expect(running?.blocked).toBe(2);
    expect(running?.durationMs).toBeNull();
    // 等待中的第三轮：heldRound === 3 的两个 run 都计入 blocked。
    expect(waiting?.status).toBe("waiting");
    expect(waiting?.blocked).toBe(2);
    // 已完成轮次不再报告阻塞。
    expect(summaries.find((summary) => summary.round === 1)?.blocked).toBe(0);
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
      executed: 1,
      passed: 1,
      roundPassRate: 100,
      overallPassRate: 100,
      durationMs: 60_000,
    });
  });

  it("returns a single waiting round when no attempts exist", () => {
    const batch = makeBatch({ totalRuns: 2 });
    const runs = [makeRun("run-1"), makeRun("run-2")];

    const summaries = summarizeRunBatchRounds(batch, runs, []);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      round: 1,
      status: "waiting",
      totalRuns: 2,
      executed: 0,
      blocked: 0,
      roundPassRate: null,
      overallPassRate: 0,
      startedAt: null,
      durationMs: null,
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
