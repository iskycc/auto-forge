import type { RunBatch } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import {
  isActiveRunBatch,
  runBatchCompletionPercent,
  runBatchCoveragePercent,
  runBatchStatusLabel,
} from "./run-batch-presentation";

describe("run batch presentation", () => {
  it("distinguishes active and terminal states", () => {
    expect(isActiveRunBatch("scheduled")).toBe(true);
    expect(isActiveRunBatch("running")).toBe(true);
    expect(isActiveRunBatch("succeeded")).toBe(false);
    expect(runBatchStatusLabel("failed")).toBe("已失败");
  });

  it("reports progress across assigned and terminal runs", () => {
    expect(
      runBatchCoveragePercent(
        batch({ assignedRuns: 2, succeededRuns: 1, failedRuns: 1, queuedRuns: 1 }),
      ),
    ).toBe(80);
  });

  it("bounds progress for defensive rendering", () => {
    expect(runBatchCoveragePercent(batch({ assignedRuns: 8 }))).toBe(100);
    expect(runBatchCoveragePercent(batch({ totalRuns: 0 }))).toBe(0);
    expect(runBatchCompletionPercent(batch({ succeededRuns: 2, failedRuns: 1 }))).toBe(60);
  });
});

function batch(overrides: Partial<RunBatch>): RunBatch {
  return {
    id: "batch-1",
    projectId: "project-1",
    suiteId: "suite-1",
    suiteName: "每日冒烟",
    suiteVersion: 1,
    status: "scheduled",
    priority: 0,
    retryLimit: 0,
    queueTimeoutMs: 86_400_000,
    claimTimeoutMs: 300_000,
    executionTimeoutMs: 3_600_000,
    uploadTimeoutMs: 600_000,
    environmentVariables: [],
    secretBindings: [],
    selectedRunnerIds: ["runner-1"],
    totalRuns: 5,
    queuedRuns: 5,
    assignedRuns: 0,
    runningRuns: 0,
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
