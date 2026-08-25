import type { RunBatchDetails } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { toExecutionBatchView } from "./execution-batch-view";

describe("execution batch public view", () => {
  it("keeps rendered results without serializing hidden execution configuration", () => {
    const view = toExecutionBatchView(batchDetails());

    expect(view).toMatchObject({
      id: "batch-1",
      status: "succeeded",
      totalRuns: 1,
      succeededRuns: 1,
      runs: [{ id: "run-1", displayName: "登录用例" }],
      attempts: [{ id: "attempt-1", resultSummary: "passed" }],
      roundRecoveries: [],
    });
    expect(view).not.toHaveProperty("environmentVariables");
    expect(view).not.toHaveProperty("secretBindings");
    expect(view).not.toHaveProperty("selectedRunnerIds");
    expect(view).not.toHaveProperty("policy");
    expect(view).not.toHaveProperty("statusHistory");
    expect(view).not.toHaveProperty("suiteId");
    expect(view).not.toHaveProperty("projectId");
  });
});

function batchDetails(): RunBatchDetails {
  return {
    id: "batch-1",
    sequenceNumber: 1,
    projectId: "project-private",
    suiteId: "suite-private",
    suiteName: "回归任务",
    suiteVersion: 3,
    status: "succeeded",
    priority: 0,
    retryLimit: 1,
    retryMode: "round",
    currentRound: 1,
    queueTimeoutMs: 60_000,
    claimTimeoutMs: 60_000,
    executionTimeoutMs: 60_000,
    uploadTimeoutMs: 60_000,
    environmentVariables: [{ name: "LEGACY_PRIVATE", value: "must-not-leak" }],
    secretBindings: [
      { name: "LEGACY_SECRET", secretId: "secret-1", secretVersionId: "secret-version-1" },
    ],
    selectedRunnerIds: ["runner-1"],
    policy: {
      executor: "testng",
      concurrency: 10,
      runnerLabels: ["private-label"],
      artifactPatterns: ["private/**/*.xml"],
    },
    totalRuns: 1,
    queuedRuns: 0,
    assignedRuns: 0,
    runningRuns: 0,
    succeededRuns: 1,
    failedRuns: 0,
    timedOutRuns: 0,
    cancelledRuns: 0,
    version: 2,
    scheduledFor: "2026-08-25T00:00:00.000Z",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:01:00.000Z",
    runs: [
      {
        id: "run-1",
        batchId: "batch-1",
        caseDefinitionId: "case-1",
        caseVersion: 1,
        displayName: "登录用例",
        className: "test.LoginTest",
        status: "succeeded",
        assignedRunnerId: "runner-1",
        attemptCount: 1,
        terminalOutcome: "succeeded",
        version: 2,
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:01:00.000Z",
      },
    ],
    attempts: [
      {
        id: "attempt-1",
        executionRunId: "run-1",
        runnerId: "runner-1",
        attemptNumber: 1,
        status: "succeeded",
        schedulingScore: 1,
        version: 2,
        outcome: "succeeded",
        resultCode: "TESTNG_SUCCEEDED",
        resultSummary: "passed",
        durationMs: 500,
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    ],
    roundRecoveries: [],
    statusHistory: [
      {
        id: "event-1",
        batchId: "batch-1",
        toStatus: "succeeded",
        batchVersion: 2,
        reason: "private scheduling context",
        recordedAt: "2026-08-25T00:01:00.000Z",
      },
    ],
  };
}
