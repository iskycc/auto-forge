import { describe, expect, it } from "vitest";

import { evaluateRunnerForScheduling, scheduleExecutionRuns } from "../src/scheduler";
import { statusAfterFailedAttempt, type ExecutionRun } from "../src/run-batch";
import type { Runner } from "../src/runner";

const thresholds = {
  maximumCpuUtilizationPercent: 80,
  maximumMemoryUtilizationPercent: 85,
  maximumLoadPerCpu: 1,
};
const freshAfter = "2026-08-09T00:00:00.000Z";

describe("dynamic execution scheduler", () => {
  it("reserves JVM memory before the next heartbeat instead of filling every configured slot", () => {
    const node = runner("memory-bound", { cpu: 10, memory: 25, load: 0.1, concurrency: 32 });
    node.resourceSnapshot = {
      ...node.resourceSnapshot!,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryAvailableBytes: 12 * 1024 ** 3,
    };
    const plan = scheduleExecutionRuns({
      runs: Array.from({ length: 12 }, (_, index) => run(`run-${index}`)),
      candidates: [{ runner: node, reservedSlots: 0 }],
      thresholds,
      metricsFreshAfter: freshAfter,
    });
    // 12 GiB available - 15% system reserve leaves room for four 2 GiB attempts.
    expect(plan.decisions).toHaveLength(4);
    expect(plan.unassignedRunIds).toHaveLength(8);
    expect(
      evaluateRunnerForScheduling({ runner: node, reservedSlots: 4 }, thresholds, freshAfter),
    ).toMatchObject({
      eligible: false,
      availableSlots: 0,
      blockReasons: ["memory_reservation_exhausted"],
    });
    expect(
      evaluateRunnerForScheduling({ runner: node, reservedSlots: 3 }, thresholds, freshAfter),
    ).toMatchObject({ eligible: true, availableSlots: 1 });
  });

  it("deducts only unaccounted growth while reserving new assignments at their full limit", () => {
    const node = runner("memory-bound", { cpu: 6.5, memory: 57.78, load: 0.1, concurrency: 10 });
    node.busySlots = 5;
    node.resourceSnapshot = {
      ...node.resourceSnapshot!,
      memoryTotalBytes: Math.floor(31.4 * 1024 ** 3),
      memoryAvailableBytes: Math.floor(13.26 * 1024 ** 3),
      memoryExecutionCreditBytes: 8 * 1024 ** 3,
    };
    const input = {
      runs: Array.from({ length: 10 }, (_, index) => run(`memory-${index}`)),
      candidates: [{ runner: node, reservedSlots: 5 }],
      thresholds: { ...thresholds, maximumMemoryUtilizationPercent: 90 },
      metricsFreshAfter: freshAfter,
    };
    // 13.26 available + 8 already counted - 3.14 retained - 5*2 committed = 8.12 GiB.
    expect(scheduleExecutionRuns(input).decisions).toHaveLength(4);
    expect(
      scheduleExecutionRuns({ ...input, candidates: [{ runner: node, reservedSlots: 9 }] })
        .decisions,
    ).toHaveLength(0);
    delete node.resourceSnapshot.memoryExecutionCreditBytes;
    expect(scheduleExecutionRuns(input).decisions).toHaveLength(0);
  });

  it("spreads 70 shared reservations across eight healthy nodes despite different resource scores", () => {
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      runner: runner(`node-${index}`, {
        cpu: 5 + index * 7,
        memory: 10 + index * 5,
        load: index / 10,
        concurrency: 10,
      }),
      reservedSlots: 0,
    }));
    const first = scheduleExecutionRuns({
      runs: Array.from({ length: 30 }, (_, index) => run(`ordinary-${index}`)),
      candidates,
      thresholds,
      metricsFreshAfter: freshAfter,
    });
    for (const decision of first.decisions)
      candidates.find(({ runner }) => runner.id === decision.runnerId)!.reservedSlots++;
    const second = scheduleExecutionRuns({
      runs: Array.from({ length: 40 }, (_, index) => run(`ddt-${index}`)),
      candidates,
      thresholds,
      metricsFreshAfter: freshAfter,
    });
    const counts = candidates.map(
      ({ runner: node, reservedSlots }) =>
        reservedSlots + second.decisions.filter(({ runnerId }) => runnerId === node.id).length,
    );
    expect(second.decisions).toHaveLength(40);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(70);
  });

  it("never lends stale execution credit to pending assignments after live work ended", () => {
    const node = runner("node", { cpu: 10, memory: 30, load: 0, concurrency: 10 });
    node.busySlots = 4;
    node.resourceSnapshot = {
      ...node.resourceSnapshot!,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryAvailableBytes: 12 * 1024 ** 3,
      memoryExecutionCreditBytes: 4 * 1024 ** 3,
    };
    const plan = scheduleExecutionRuns({
      runs: Array.from({ length: 10 }, (_, i) => run(`pending-${i}`)),
      candidates: [{ runner: node, reservedSlots: 0, liveAvailableSlots: 10 }],
      thresholds,
      metricsFreshAfter: freshAfter,
    });
    expect(plan.decisions).toHaveLength(4);
  });

  it("preserves worst-case growth for every active JVM across all memory observations", () => {
    const gib = 1024 ** 3;
    for (let busy = 0; busy <= 10; busy++)
      for (let usage = 0; usage <= busy * 2; usage++) {
        const node = runner("node", { cpu: 10, memory: 20, load: 0, concurrency: 10 });
        node.busySlots = busy;
        node.resourceSnapshot = {
          ...node.resourceSnapshot!,
          memoryTotalBytes: 32 * gib,
          memoryAvailableBytes: (26 - usage) * gib,
          memoryExecutionCreditBytes: usage * gib,
        };
        const plan = scheduleExecutionRuns({
          runs: Array.from({ length: 10 }, (_, i) => run(`growth-${i}`)),
          candidates: [{ runner: node, reservedSlots: busy }],
          thresholds,
          metricsFreshAfter: freshAfter,
        });
        // External working set is 6 GiB; every current/new JVM may grow to 2 GiB.
        expect(
          6 * gib + (busy + plan.decisions.length) * 2 * gib + Math.ceil(32 * gib * 0.15),
        ).toBeLessThanOrEqual(32 * gib);
        expect(busy + plan.decisions.length).toBeLessThanOrEqual(10);
      }
  });

  it("counts new assignments above live occupied slots even when database occupancy lags", () => {
    const node = runner("live", { cpu: 10, memory: 20, load: 0, concurrency: 10 });
    node.busySlots = 8;
    expect(
      scheduleExecutionRuns({
        runs: Array.from({ length: 10 }, (_, i) => run(`live-${i}`)),
        candidates: [{ runner: node, reservedSlots: 0 }],
        thresholds,
        metricsFreshAfter: freshAfter,
      }).decisions,
    ).toHaveLength(2);
  });

  it("lets legacy nodes use threshold-only admission without per-attempt reservations", () => {
    const node = runner("legacy", { cpu: 10, memory: 60, load: 0, concurrency: 10 });
    node.busySlots = 5;
    node.resourceSnapshot = {
      ...node.resourceSnapshot!,
      memoryTotalBytes: 32 * 1024 ** 3,
      memoryAvailableBytes: 12 * 1024 ** 3,
    };
    const input = {
      runs: Array.from({ length: 10 }, (_, i) => run(`legacy-${i}`)),
      candidates: [{ runner: node, reservedSlots: 5 }],
      thresholds,
      metricsFreshAfter: freshAfter,
    };
    expect(scheduleExecutionRuns(input).decisions).toHaveLength(0);
    expect(
      scheduleExecutionRuns({
        ...input,
        thresholds: { ...thresholds, memoryAdmissionMode: "threshold" },
      }).decisions,
    ).toHaveLength(5);
  });

  it("only the explicit disabled mode bypasses both memory gates", () => {
    const node = runner("legacy", { cpu: 10, memory: 99, load: 0, concurrency: 10 });
    node.resourceSnapshot = {
      ...node.resourceSnapshot!,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryAvailableBytes: 0,
    };
    const candidate = { runner: node, reservedSlots: 0 };
    expect(
      evaluateRunnerForScheduling(
        candidate,
        { ...thresholds, memoryAdmissionMode: "threshold" },
        freshAfter,
      ).blockReasons,
    ).toEqual(["memory_limit_exceeded"]);
    expect(
      evaluateRunnerForScheduling(
        candidate,
        { ...thresholds, memoryAdmissionMode: "disabled" },
        freshAfter,
      ),
    ).toMatchObject({ eligible: true, availableSlots: 10, blockReasons: [] });
    expect(
      evaluateRunnerForScheduling(
        candidate,
        { ...thresholds, maximumMemoryUtilizationPercent: 100 },
        freshAfter,
      ).blockReasons,
    ).toContain("memory_reservation_exhausted");
    for (const updated of [
      { ...node, state: "offline" as const },
      { ...node, busySlots: 10 },
      { ...node, resourceSnapshot: { ...node.resourceSnapshot!, cpuUtilizationPercent: 99 } },
      {
        ...node,
        resourceSnapshot: { ...node.resourceSnapshot!, observedAt: "2020-01-01T00:00:00.000Z" },
      },
    ])
      expect(
        evaluateRunnerForScheduling(
          { runner: updated, reservedSlots: 0 },
          { ...thresholds, memoryAdmissionMode: "disabled" },
          freshAfter,
        ).eligible,
      ).toBe(false);
  });

  it("includes live occupied slots and never lets a claim hint bypass persisted memory reservations", () => {
    const node = runner("memory-bound", { cpu: 10, memory: 25, load: 0.1, concurrency: 32 });
    node.resourceSnapshot = {
      ...node.resourceSnapshot!,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryAvailableBytes: 12 * 1024 ** 3,
    };
    for (const candidate of [
      { runner: { ...node, busySlots: 4 }, reservedSlots: 0 },
      { runner: node, reservedSlots: 4, liveAvailableSlots: 32 },
    ]) {
      expect(evaluateRunnerForScheduling(candidate, thresholds, freshAfter).blockReasons).toContain(
        "memory_reservation_exhausted",
      );
    }
  });

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

  it("balances simultaneous retries before using their cyclic tie breaker", () => {
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      runner: runner(`node-${index}`, { cpu: 10, memory: 20, load: 0, concurrency: 10 }),
      reservedSlots: 0,
    }));
    const runs = Array.from({ length: 40 }, (_, index) => run(`retry-${index}`));
    const plan = scheduleExecutionRuns({
      runs,
      candidates,
      runnerHistoryByRun: new Map(runs.map(({ id }) => [id, ["node-0"]])),
      thresholds,
      metricsFreshAfter: freshAfter,
    });
    expect(plan.decisions[0]?.runnerId).toBe("node-1");
    expect(
      candidates.map(
        ({ runner: node }) => plan.decisions.filter(({ runnerId }) => runnerId === node.id).length,
      ),
    ).toEqual(Array(8).fill(5));
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

  it("uses authenticated claim capacity without bypassing database reservations", () => {
    const staleHeartbeat = runner("runner-live", {
      cpu: 10,
      memory: 20,
      load: 0.1,
      concurrency: 2,
    });
    staleHeartbeat.busySlots = 2;

    const refill = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates: [
        {
          runner: staleHeartbeat,
          reservedSlots: 1,
          liveAvailableSlots: 1,
        },
      ],
      thresholds,
      metricsFreshAfter: freshAfter,
    });
    const reserved = scheduleExecutionRuns({
      runs: [run("run-1")],
      candidates: [
        {
          runner: staleHeartbeat,
          reservedSlots: 2,
          liveAvailableSlots: 1,
        },
      ],
      thresholds,
      metricsFreshAfter: freshAfter,
    });

    expect(refill.decisions).toEqual([
      expect.objectContaining({ executionRunId: "run-1", runnerId: "runner-live" }),
    ]);
    expect(refill.evaluations[0]?.availableSlots).toBe(1);
    expect(reserved.decisions).toEqual([]);
    expect(reserved.evaluations[0]?.blockReasons).toContain("capacity_exhausted");
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
