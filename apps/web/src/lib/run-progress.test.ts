import type { RunAttempt, RunBatchDetails } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { buildRunProgress } from "./run-progress";

const timestamp = "2026-08-20T00:00:00.000Z";

describe("Jenkins and public run progress", () => {
  it("reports the active immediate retry number and cumulative final results", () => {
    const progress = buildRunProgress(
      batch({
        status: "succeeded",
        succeededRuns: 2,
        attempts: [
          attempt("attempt-1", "run-1", 1, "failed", "TESTNG_ASSERTIONS_FAILED"),
          attempt("attempt-2", "run-2", 1, "succeeded", "TESTNG_SUCCEEDED"),
          attempt("attempt-3", "run-1", 2, "succeeded", "TESTNG_SUCCEEDED"),
        ],
      }),
    );

    expect(progress).toMatchObject({
      statusLabel: "执行完成",
      active: false,
      currentRound: 2,
      maximumRounds: 3,
      totalCases: 2,
      completedCases: 2,
      totalPassed: 2,
      finalFailed: 0,
      currentRoundTotal: 1,
      currentRoundPassed: 1,
      currentRoundFailed: 0,
      currentRoundCompleted: 1,
    });
  });

  it("distinguishes infrastructure exceptions and user termination", () => {
    const exception = buildRunProgress(
      batch({
        status: "failed",
        failedRuns: 1,
        succeededRuns: 1,
        attempts: [
          attempt("attempt-1", "run-1", 1, "failed", "PROCESS_START_FAILED"),
          attempt("attempt-2", "run-2", 1, "succeeded", "TESTNG_SUCCEEDED"),
        ],
      }),
    );
    const interrupted = buildRunProgress(batch({ status: "cancelled", cancelledRuns: 2 }));

    expect(exception.statusLabel).toBe("执行异常");
    expect(interrupted.statusLabel).toBe("已终止");
  });

  it("reports the complete current-round denominator before attempts are assigned", () => {
    const progress = buildRunProgress(batch({ status: "queued" }));

    expect(progress).toMatchObject({
      currentRound: 1,
      currentRoundTotal: 2,
      currentRoundCompleted: 0,
    });
  });
});

function batch(
  overrides: Partial<RunBatchDetails> & Pick<RunBatchDetails, "status">,
): RunBatchDetails {
  return {
    id: "batch-1",
    sequenceNumber: 1,
    projectId: "project-1",
    suiteId: "suite-1",
    suiteName: "回归任务",
    suiteVersion: 1,
    priority: 0,
    retryLimit: 2,
    retryMode: "immediate",
    currentRound: 1,
    queueTimeoutMs: 60_000,
    claimTimeoutMs: 60_000,
    executionTimeoutMs: 600_000,
    uploadTimeoutMs: 60_000,
    environmentVariables: [],
    secretBindings: [],
    selectedRunnerIds: ["runner-1"],
    totalRuns: 2,
    queuedRuns: 0,
    assignedRuns: 0,
    runningRuns: 0,
    succeededRuns: 0,
    failedRuns: 0,
    timedOutRuns: 0,
    cancelledRuns: 0,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    runs: [run("run-1", "case-1"), run("run-2", "case-2")],
    attempts: [],
    statusHistory: [],
    ...overrides,
  };
}

function run(id: string, caseDefinitionId: string): RunBatchDetails["runs"][number] {
  return {
    id,
    batchId: "batch-1",
    caseDefinitionId,
    caseVersion: 1,
    displayName: caseDefinitionId,
    className: `com.example.${caseDefinitionId}`,
    status: "succeeded",
    attemptCount: 1,
    terminalOutcome: "succeeded",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function attempt(
  id: string,
  executionRunId: string,
  attemptNumber: number,
  outcome: NonNullable<RunAttempt["outcome"]>,
  resultCode: string,
): RunAttempt {
  return {
    id,
    executionRunId,
    runnerId: "runner-1",
    attemptNumber,
    status: outcome === "timed_out" ? "timed_out" : outcome,
    schedulingScore: 0,
    version: 1,
    outcome,
    resultCode,
    createdAt: timestamp,
    finishedAt: timestamp,
  };
}
