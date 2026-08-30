import { describe, expect, it } from "vitest";

import { scheduleExecutionRuns } from "../src/scheduler";
import { statusAfterFailedAttempt, type ExecutionRun } from "../src/run-batch";
import type { Runner } from "../src/runner";

const thresholds = {
  maximumCpuUtilizationPercent: 80,
  maximumMemoryUtilizationPercent: 85,
  maximumLoadPerCpu: 1,
};
const freshAfter = "2026-08-09T00:00:00.000Z";

describe("dynamic execution scheduler", () => {
  it("filters overloaded runners and spreads runs as capacity scores decline", () => {
    const plan = scheduleExecutionRuns({
      runs: [run("run-1"), run("run-2"), run("run-3")],
      candidates: [
        {
          runner: runner("runner-a", { cpu: 20, memory: 30, load: 0.4, concurrency: 2 }),
          reservedSlots: 0,
        },
        {
          runner: runner("runner-b", { cpu: 25, memory: 35, load: 0.5, concurrency: 2 }),
          reservedSlots: 0,
        },
        {
          runner: runner("runner-hot", { cpu: 91, memory: 30, load: 0.2, concurrency: 4 }),
          reservedSlots: 0,
        },
      ],
      thresholds,
      metricsFreshAfter: freshAfter,
    });

    expect(plan.decisions).toHaveLength(3);
    expect(new Set(plan.decisions.map((decision) => decision.runnerId))).toEqual(
      new Set(["runner-a", "runner-b"]),
    );
    expect(
      plan.evaluations.find((value) => value.runnerId === "runner-hot")?.blockReasons,
    ).toContain("cpu_limit_exceeded");
    expect(plan.unassignedRunIds).toEqual([]);
  });

  it("caps new assignments by the batch concurrency budget", () => {
    const plan = scheduleExecutionRuns({
      runs: [run("run-1"), run("run-2"), run("run-3")],
      candidates: [
        {
          runner: runner("runner-a", { cpu: 20, memory: 30, load: 0.4, concurrency: 8 }),
          reservedSlots: 0,
        },
      ],
      thresholds,
      metricsFreshAfter: freshAfter,
      maxAssignments: 2,
    });

    expect(plan.decisions).toHaveLength(2);
    expect(plan.decisions.map((decision) => decision.executionRunId)).toEqual(["run-1", "run-2"]);
    expect(plan.unassignedRunIds).toEqual(["run-3"]);
  });

  it("assigns nothing when the batch concurrency budget is exhausted", () => {
    const plan = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates: [
        {
          runner: runner("runner-a", { cpu: 20, memory: 30, load: 0.4, concurrency: 8 }),
          reservedSlots: 0,
        },
      ],
      thresholds,
      metricsFreshAfter: freshAfter,
      maxAssignments: 0,
    });

    expect(plan.decisions).toEqual([]);
    expect(plan.unassignedRunIds).toEqual(["run-1"]);
  });

  it("moves an infrastructure retry to another healthy Runner when possible", () => {
    const plan = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates: [
        {
          runner: runner("runner-fast-but-faulted", {
            cpu: 5,
            memory: 10,
            load: 0.1,
            concurrency: 4,
          }),
          reservedSlots: 0,
        },
        {
          runner: runner("runner-alternative", {
            cpu: 30,
            memory: 40,
            load: 0.4,
            concurrency: 4,
          }),
          reservedSlots: 0,
        },
      ],
      excludedRunnerIdsByRun: new Map([["run-1", new Set(["runner-fast-but-faulted"])]]),
      thresholds,
      metricsFreshAfter: freshAfter,
    });

    expect(plan.decisions[0]?.runnerId).toBe("runner-alternative");
  });

  it("falls back to the only healthy Runner instead of leaving a retry stuck", () => {
    const plan = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates: [
        {
          runner: runner("runner-only", { cpu: 20, memory: 20, load: 0.2, concurrency: 1 }),
          reservedSlots: 0,
        },
      ],
      excludedRunnerIdsByRun: new Map([["run-1", new Set(["runner-only"])]]),
      thresholds,
      metricsFreshAfter: freshAfter,
    });

    expect(plan.decisions[0]?.runnerId).toBe("runner-only");
  });

  it("rotates every retry to the next healthy Runner in stable order", () => {
    const candidates = [
      {
        runner: runner("runner-c", { cpu: 5, memory: 10, load: 0.1, concurrency: 4 }),
        reservedSlots: 0,
      },
      {
        runner: runner("runner-a", { cpu: 30, memory: 40, load: 0.4, concurrency: 4 }),
        reservedSlots: 0,
      },
      {
        runner: runner("runner-b", { cpu: 20, memory: 30, load: 0.3, concurrency: 4 }),
        reservedSlots: 0,
      },
    ];

    const afterA = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates,
      runnerHistoryByRun: new Map([["run-1", ["runner-a"]]]),
      thresholds,
      metricsFreshAfter: freshAfter,
    });
    const afterB = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates,
      runnerHistoryByRun: new Map([["run-1", ["runner-a", "runner-b"]]]),
      thresholds,
      metricsFreshAfter: freshAfter,
    });
    const afterC = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates,
      runnerHistoryByRun: new Map([["run-1", ["runner-a", "runner-b", "runner-c"]]]),
      thresholds,
      metricsFreshAfter: freshAfter,
    });

    expect(afterA.decisions[0]?.runnerId).toBe("runner-b");
    expect(afterB.decisions[0]?.runnerId).toBe("runner-c");
    expect(afterC.decisions[0]?.runnerId).toBe("runner-a");
  });

  it("skips an unavailable next Runner while retaining infrastructure exclusions", () => {
    const unavailable = runner("runner-b", {
      cpu: 20,
      memory: 30,
      load: 0.3,
      concurrency: 1,
    });
    unavailable.busySlots = 1;
    const plan = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates: [
        {
          runner: runner("runner-a", { cpu: 10, memory: 20, load: 0.2, concurrency: 2 }),
          reservedSlots: 0,
        },
        { runner: unavailable, reservedSlots: 0 },
        {
          runner: runner("runner-c", { cpu: 30, memory: 40, load: 0.4, concurrency: 2 }),
          reservedSlots: 0,
        },
      ],
      runnerHistoryByRun: new Map([["run-1", ["runner-a"]]]),
      excludedRunnerIdsByRun: new Map([["run-1", new Set(["runner-a"])]]),
      thresholds,
      metricsFreshAfter: freshAfter,
    });

    expect(plan.decisions[0]?.runnerId).toBe("runner-c");
  });

  it("keeps runs queued when metrics are stale or capacity is exhausted", () => {
    const stale = runner("runner-stale", { cpu: 10, memory: 20, load: 0.1, concurrency: 1 });
    stale.resourceSnapshot = { ...stale.resourceSnapshot!, observedAt: "2026-08-08T23:59:00.000Z" };
    const full = runner("runner-full", { cpu: 10, memory: 20, load: 0.1, concurrency: 1 });
    full.busySlots = 1;

    const plan = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates: [
        { runner: stale, reservedSlots: 0 },
        { runner: full, reservedSlots: 0 },
      ],
      thresholds,
      metricsFreshAfter: freshAfter,
    });

    expect(plan.decisions).toEqual([]);
    expect(plan.unassignedRunIds).toEqual(["run-1"]);
    expect(plan.evaluations.map((value) => value.blockReasons)).toEqual([
      ["metrics_stale"],
      ["capacity_exhausted"],
    ]);
  });

  it("explains incompatible Runner capabilities without assigning work", () => {
    const incompatible = runner("runner-incompatible", {
      cpu: 10,
      memory: 20,
      load: 0.1,
      concurrency: 1,
    });
    incompatible.capabilities = ["executor:testng-v1"];

    const plan = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates: [{ runner: incompatible, reservedSlots: 0 }],
      thresholds,
      metricsFreshAfter: freshAfter,
    });

    expect(plan.decisions).toEqual([]);
    expect(plan.evaluations[0]?.blockReasons).toContain("runner_incompatible");
  });

  it("allows exactly the configured number of retries", () => {
    expect(statusAfterFailedAttempt(1, 2)).toBe("queued");
    expect(statusAfterFailedAttempt(2, 2)).toBe("queued");
    expect(statusAfterFailedAttempt(3, 2)).toBe("failed");
  });
});

function run(id: string): ExecutionRun {
  return {
    id,
    batchId: "batch-1",
    caseDefinitionId: `case-${id}`,
    caseVersion: 1,
    displayName: id,
    className: `example.${id}`,
    status: "queued",
    attemptCount: 0,
    createdAt: freshAfter,
    updatedAt: freshAfter,
  };
}

function runner(
  id: string,
  values: { cpu: number; memory: number; load: number; concurrency: number },
): Runner {
  return {
    id,
    name: id,
    state: "online",
    os: "linux",
    architecture: "amd64",
    agentVersion: "test",
    protocolVersion: 1,
    labels: [],
    capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
    maxConcurrency: values.concurrency,
    busySlots: 0,
    lastSeenAt: "2026-08-09T00:00:10.000Z",
    resourceSnapshot: {
      cpuUtilizationPercent: values.cpu,
      memoryUtilizationPercent: values.memory,
      loadAverage1m: values.load,
      logicalCpuCount: 1,
      observedAt: "2026-08-09T00:00:10.000Z",
    },
    terminalEnabled: false,
    createdAt: freshAfter,
    updatedAt: freshAfter,
  };
}
