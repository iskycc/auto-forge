import { describe, expect, it } from "vitest";

import {
  aggregateBatchStatus,
  assertActiveLease,
  assertExecutionRunInvariant,
  assertRunAttemptInvariant,
  outcomeAfterCompletion,
  transitionAssignment,
  transitionExecutionRun,
  transitionLease,
  transitionRunBatch,
  transitionRunAttempt,
} from "../src/execution";

describe("execution state machine", () => {
  it("rejects terminal assignment transitions", () => {
    expect(transitionAssignment("pending", "claimed")).toBe("claimed");
    expect(() => transitionAssignment("completed", "running")).toThrow(
      "Assignment cannot transition",
    );
  });

  it("protects terminal run, attempt, and lease states", () => {
    expect(transitionExecutionRun("running", "succeeded")).toBe("succeeded");
    expect(transitionRunAttempt("assigned", "timed_out")).toBe("timed_out");
    expect(transitionLease("active", "revoked")).toBe("revoked");
    expect(() => transitionExecutionRun("succeeded", "running")).toThrow(
      "EXECUTION_RUN cannot transition",
    );
    expect(() => transitionRunAttempt("failed", "running")).toThrow(
      "RUN_ATTEMPT cannot transition",
    );
    expect(() => transitionLease("released", "active")).toThrow("LEASE cannot transition");
  });

  it("protects terminal batch states while allowing retry scheduling", () => {
    expect(transitionRunBatch("running", "queued")).toBe("queued");
    expect(transitionRunBatch("scheduled", "running")).toBe("running");
    expect(() => transitionRunBatch("succeeded", "running")).toThrow("RUN_BATCH cannot transition");
  });

  it("requires terminal results to be complete and internally consistent", () => {
    const run = {
      id: "run-1",
      batchId: "batch-1",
      caseDefinitionId: "case-1",
      caseVersion: 1,
      displayName: "Run",
      className: "example.RunTest",
      status: "failed" as const,
      attemptCount: 1,
      terminalOutcome: "timed_out" as const,
      version: 2,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:01:00.000Z",
    };
    expect(() => assertExecutionRunInvariant(run)).not.toThrow();
    expect(() =>
      assertExecutionRunInvariant({ ...run, status: "succeeded", terminalOutcome: "failed" }),
    ).toThrow("成功状态必须对应成功结果");

    const attempt = {
      id: "attempt-1",
      executionRunId: "run-1",
      runnerId: "runner-1",
      attemptNumber: 1,
      status: "timed_out" as const,
      schedulingScore: 1,
      version: 2,
      finishedAt: "2026-08-09T00:01:00.000Z",
      outcome: "timed_out" as const,
      createdAt: "2026-08-09T00:00:00.000Z",
    };
    expect(() => assertRunAttemptInvariant(attempt)).not.toThrow();
    expect(() => assertRunAttemptInvariant({ ...attempt, outcome: "failed" })).toThrow(
      "状态与结果不一致",
    );
  });

  it("uses lease version and server UTC expiry as the execution authority", () => {
    expect(() =>
      assertActiveLease({
        status: "active",
        expiresAt: "2026-08-09T00:00:00.000Z",
        expectedVersion: 2,
        actualVersion: 2,
        now: "2026-08-09T00:00:01.000Z",
      }),
    ).toThrow("租约已过期");
    expect(() =>
      assertActiveLease({
        status: "active",
        expiresAt: "2026-08-09T00:01:00.000Z",
        expectedVersion: 1,
        actualVersion: 2,
        now: "2026-08-09T00:00:01.000Z",
      }),
    ).toThrow("租约版本已变化");
  });

  it("retries only failures and derives batch status from authoritative runs", () => {
    expect(
      outcomeAfterCompletion({
        outcome: "failed",
        attemptNumber: 1,
        retryLimit: 1,
        cancellationRequested: false,
      }),
    ).toEqual({ runStatus: "queued", retryScheduled: true });
    expect(
      outcomeAfterCompletion({
        outcome: "cancelled",
        attemptNumber: 1,
        retryLimit: 10,
        cancellationRequested: false,
      }),
    ).toEqual({ runStatus: "cancelled", retryScheduled: false });
    expect(aggregateBatchStatus(["succeeded", "failed", "cancelled"])).toBe("failed");
    expect(aggregateBatchStatus(["assigned", "queued"])).toBe("dispatching");
  });
});
