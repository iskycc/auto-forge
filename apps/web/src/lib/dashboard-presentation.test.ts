import { describe, expect, it } from "vitest";

import {
  calculateQualityDelta,
  selectDashboardFocus,
  summarizeActiveRuns,
  summarizeRunnerCapacity,
} from "./dashboard-presentation";

describe("dashboard presentation", () => {
  it("only compares quality periods that both contain confirmed samples", () => {
    expect(
      calculateQualityDelta(
        { sampleCount: 3, successRate: 0.5 },
        { sampleCount: 0, successRate: 0 },
      ),
    ).toBeNull();
    expect(
      calculateQualityDelta(
        { sampleCount: 5, successRate: 0.9 },
        { sampleCount: 4, successRate: 0.75 },
      ),
    ).toBeCloseTo(15);
  });

  it("aggregates active batches without hiding assigned or timed out runs", () => {
    expect(
      summarizeActiveRuns([
        {
          totalRuns: 12,
          runningRuns: 3,
          succeededRuns: 4,
          failedRuns: 1,
          timedOutRuns: 1,
          queuedRuns: 2,
          assignedRuns: 1,
        },
        {
          totalRuns: 8,
          runningRuns: 2,
          succeededRuns: 3,
          failedRuns: 0,
          timedOutRuns: 0,
          queuedRuns: 2,
          assignedRuns: 1,
        },
      ]),
    ).toEqual({
      batchCount: 2,
      totalRuns: 20,
      runningRuns: 5,
      succeededRuns: 7,
      failedRuns: 2,
      pendingRuns: 6,
    });
  });

  it("derives available online capacity and bounded resource averages", () => {
    expect(
      summarizeRunnerCapacity([
        {
          state: "online",
          maxConcurrency: 8,
          busySlots: 3,
          resourceSnapshot: {
            cpuUtilizationPercent: 30,
            memoryUtilizationPercent: 50,
            loadAverage1m: 2,
            logicalCpuCount: 8,
            observedAt: "2026-09-04T00:00:00.000Z",
          },
        },
        {
          state: "online",
          maxConcurrency: 4,
          busySlots: 9,
          resourceSnapshot: {
            cpuUtilizationPercent: 50,
            memoryUtilizationPercent: 70,
            loadAverage1m: 3,
            logicalCpuCount: 4,
            observedAt: "2026-09-04T00:00:00.000Z",
          },
        },
        { state: "offline", maxConcurrency: 16, busySlots: 0 },
      ]),
    ).toEqual({
      runnerCount: 3,
      onlineRunnerCount: 2,
      unavailableRunnerCount: 1,
      onlineSlots: 12,
      busySlots: 7,
      availableSlots: 5,
      utilizationPercent: 58,
      averageCpuPercent: 40,
      averageMemoryPercent: 60,
    });
  });

  it("prioritizes active execution, failures and unavailable runners", () => {
    const base = {
      failedMethods: 7,
      unavailableRunners: 2,
      enabledMethods: 12,
      canReadRuns: true,
      canReadRunners: true,
      canReadCases: true,
    };
    expect(
      selectDashboardFocus({
        ...base,
        activeBatch: {
          id: "batch-1",
          suiteName: "冒烟回归",
          runningRuns: 4,
          queuedRuns: 3,
        },
      }),
    ).toMatchObject({ href: "/run-batches/batch-1", tone: "info" });
    expect(selectDashboardFocus(base)).toMatchObject({ href: "/case-analysis", tone: "danger" });
    expect(selectDashboardFocus({ ...base, failedMethods: 0 })).toMatchObject({
      href: "/runners",
      tone: "warning",
    });
  });
});
