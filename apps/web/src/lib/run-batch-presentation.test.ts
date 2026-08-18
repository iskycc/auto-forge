import type { RunAttempt, RunBatch } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import {
  batchTestNames,
  formatArtifactBytes,
  formatAttemptDuration,
  formatBatchDuration,
  formatLocalDateTime,
  isActiveRunBatch,
  runBatchCompletionPercent,
  runBatchCoveragePercent,
  runBatchDurationMs,
  runBatchPassRate,
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

  it("computes pass rate from succeeded runs", () => {
    expect(runBatchPassRate(batch({ totalRuns: 4, succeededRuns: 3 }))).toBe(75);
    expect(runBatchPassRate(batch({ totalRuns: 0 }))).toBe(0);
  });

  it("computes duration between creation and terminal update", () => {
    const terminal = batch({
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:05:30.000Z",
    });
    expect(runBatchDurationMs(terminal)).toBe(330_000);
    expect(formatBatchDuration(330_000)).toBe("5m 30s");
    expect(formatBatchDuration(0)).toBe("-");
    expect(formatBatchDuration(3_661_000)).toBe("1h 1m 1s");
  });

  it("rejects non-positive durations", () => {
    expect(runBatchDurationMs(batch({ updatedAt: "2026-08-09T00:00:00.000Z" }))).toBe(0);
  });

  it("collects unique test names across attempts", () => {
    const attempts: RunAttempt[] = [
      {
        id: "attempt-1",
        executionRunId: "run-1",
        runnerId: "runner-1",
        attemptNumber: 1,
        status: "succeeded" as const,
        schedulingScore: 0,
        version: 1,
        createdAt: "2026-08-10T00:00:00.000Z",
        testNg: {
          total: 2,
          passed: 2,
          failed: 0,
          skipped: 0,
          configurationFailures: 0,
          detailsTruncated: false,
          suites: [
            {
              name: "Suite A",
              durationMs: 100,
              total: 2,
              passed: 2,
              failed: 0,
              skipped: 0,
              configurationFailures: 0,
              tests: [
                {
                  name: "Smoke",
                  durationMs: 100,
                  total: 2,
                  passed: 2,
                  failed: 0,
                  skipped: 0,
                  configurationFailures: 0,
                  classes: [],
                },
              ],
            },
          ],
        },
      },
      {
        id: "attempt-2",
        executionRunId: "run-2",
        runnerId: "runner-1",
        attemptNumber: 1,
        status: "failed" as const,
        schedulingScore: 0,
        version: 1,
        createdAt: "2026-08-10T00:00:00.000Z",
      },
    ];
    expect(batchTestNames(attempts)).toEqual(["Smoke"]);
    expect(batchTestNames([])).toEqual([]);
  });

  it("formats attempt durations, artifact sizes and local datetimes", () => {
    expect(formatAttemptDuration(420)).toBe("420 ms");
    expect(formatAttemptDuration(2_500)).toBe("2.50 s");
    expect(formatAttemptDuration(61_000)).toBe("1 min 1 s");
    expect(formatArtifactBytes(512)).toBe("512 B");
    expect(formatArtifactBytes(2_048)).toBe("2.0 KiB");
    expect(formatArtifactBytes(3 * 1_048_576)).toBe("3.0 MiB");
    expect(formatLocalDateTime("2026-08-10T00:00:00.000Z")).toContain("2026");
  });
});

function batch(overrides: Partial<RunBatch>): RunBatch {
  return {
    id: "batch-1",
    sequenceNumber: 1,
    projectId: "project-1",
    suiteId: "suite-1",
    suiteName: "每日冒烟",
    suiteVersion: 1,
    status: "scheduled",
    priority: 0,
    retryLimit: 0,
    retryMode: "immediate",
    currentRound: 1,
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
