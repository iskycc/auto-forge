import { describe, expect, it, vi } from "vitest";
import type { Runner } from "@autoforge/domain";
import { ConcurrencyDiagnosticsService } from "../src/read-concurrency-diagnostics";
import type { ConcurrencySnapshot } from "../src/concurrency-snapshot";

const now = "2026-10-25T08:00:00.000Z";
function runner(overrides: Partial<Runner> = {}): Runner {
  return {
    id: "node",
    name: "执行节点",
    state: "online",
    os: "linux",
    architecture: "amd64",
    agentVersion: "1.20.15",
    protocolVersion: 1,
    labels: ["java", "testng"],
    capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
    maxConcurrency: 10,
    busySlots: 0,
    lastSeenAt: now,
    terminalEnabled: false,
    credentialVersion: 1,
    createdAt: now,
    updatedAt: now,
    resourceSnapshot: {
      cpuUtilizationPercent: 30,
      memoryUtilizationPercent: 70,
      loadAverage1m: 0,
      logicalCpuCount: 16,
      observedAt: now,
    },
    ...overrides,
  };
}
function fixture(
  overrides: Partial<ConcurrencySnapshot> = {},
  memoryAdmissionMode: "reserved" | "threshold" | "disabled" = "reserved",
) {
  const snapshot: ConcurrencySnapshot = {
    batch: {
      id: "batch",
      projectId: "project",
      status: "running",
      scheduledFor: now,
      policy: { executor: "testng", concurrency: 40, runnerLabels: [], artifactPatterns: [] },
    },
    targetConcurrency: 40,
    runningRuns: 5,
    assignedRuns: 0,
    readyRuns: 100,
    heldRuns: 0,
    recoveryPending: false,
    projectActiveRuns: 35,
    requiredCapabilities: ["executor:testng-v1"],
    omittedNodes: 0,
    nodes: [{ runner: runner(), reservedSlots: 0, batchReservedSlots: 0 }],
    ...overrides,
  };
  const readConcurrencySnapshot = vi.fn().mockResolvedValue(snapshot);
  const service = new ConcurrencyDiagnosticsService(
    { readConcurrencySnapshot },
    { now: () => new Date(now) },
    () => ({
      thresholds: {
        memoryAdmissionMode,
        maximumCpuUtilizationPercent: 80,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      metricsMaximumAgeSeconds: 45,
      projectMaximumConcurrency: 128,
    }),
  );
  return { service, snapshot, readConcurrencySnapshot };
}
describe("on-demand concurrency diagnosis", () => {
  it("bounds long historical label lists without failing the diagnostic response", async () => {
    const f = fixture();
    f.snapshot.batch.policy!.runnerLabels = Array.from(
      { length: 30 },
      (_, index) => `${index}-${"label".repeat(200)}`,
    );
    const result = await f.service.read("batch");
    expect(result.nodes[0]?.reasons[0]?.message).toContain("共 30 项");
    expect(result.nodes[0]!.reasons[0]!.message.length).toBeLessThan(2048);
  });
  it.each([
    ["batch_terminal", { status: "succeeded" }],
    ["termination_requested", { terminationRequestedAt: now, pauseRequestedAt: now }],
    ["scheduling_paused", { pauseRequestedAt: now }],
    ["scheduled_start", { scheduledFor: "2026-10-25T09:00:00.000Z" }],
  ] satisfies Array<[string, Partial<ConcurrencySnapshot["batch"]>]>)(
    "explains %s before resource constraints",
    async (code, updates) => {
      const f = fixture();
      Object.assign(f.snapshot.batch, updates);
      expect((await f.service.read("batch")).reasons.map((reason) => reason.code)).toEqual([code]);
    },
  );
  it("explains conservative memory reservations and other task occupancy with the real scheduling rule", async () => {
    const node = runner({ busySlots: 3 });
    node.resourceSnapshot = {
      ...node.resourceSnapshot!,
      memoryTotalBytes: 32 * 1024 ** 3,
      memoryAvailableBytes: 9 * 1024 ** 3,
    };
    const f = fixture({ nodes: [{ runner: node, reservedSlots: 3, batchReservedSlots: 1 }] });
    const result = await f.service.read("batch", ["project"]);
    expect(result.nodes[0]).toMatchObject({
      availableSlots: 0,
      memoryAvailableSlots: 0,
      memoryPerAttemptBytes: 2 * 1024 ** 3,
      concurrencyAvailableSlots: 7,
      otherReservedSlots: 2,
    });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: "memory_reservation_exhausted" }),
    );
    expect(f.readConcurrencySnapshot).toHaveBeenCalledWith("batch", "2026-10-25T07:59:15.000Z", [
      "project",
    ]);
    expect(result.nodes[0]).not.toHaveProperty("capabilities");
  });
  it("exposes growth and already-counted memory using the same admission budget", async () => {
    const node = runner({ busySlots: 5 });
    node.resourceSnapshot = {
      ...node.resourceSnapshot!,
      memoryTotalBytes: 32 * 1024 ** 3,
      memoryAvailableBytes: 14 * 1024 ** 3,
      memoryExecutionCreditBytes: 8 * 1024 ** 3,
    };
    const f = fixture({ nodes: [{ runner: node, reservedSlots: 5, batchReservedSlots: 2 }] });
    expect((await f.service.read("batch")).nodes[0]).toMatchObject({
      memoryAvailableSlots: 3,
      memoryExecutionCreditBytes: 8 * 1024 ** 3,
      memoryReservedGrowthBytes: 2 * 1024 ** 3,
    });
  });
  it.each(["threshold", "disabled"] as const)(
    "explains %s mode without showing a reservation shortage",
    async (mode) => {
      const node = runner({ busySlots: 5 });
      node.resourceSnapshot = {
        ...node.resourceSnapshot!,
        memoryTotalBytes: 32 * 1024 ** 3,
        memoryAvailableBytes: 12 * 1024 ** 3,
      };
      const f = fixture(
        { nodes: [{ runner: node, reservedSlots: 5, batchReservedSlots: 2 }] },
        mode,
      );
      const result = await f.service.read("batch");
      expect(result.thresholds.memoryAdmissionMode).toBe(mode);
      expect(result.nodes[0]).toMatchObject({
        availableSlots: 5,
        memoryAvailableSlots: null,
        memoryReservedGrowthBytes: null,
      });
      expect(result.nodes[0]?.reasons).not.toContainEqual(
        expect.objectContaining({ code: "memory_reservation_exhausted" }),
      );
    },
  );
  it("reports free capacity as awaiting refill and retains percentage-only Agent compatibility", async () => {
    const f = fixture({
      nodes: [{ runner: runner({ busySlots: 4 }), reservedSlots: 5, batchReservedSlots: 2 }],
    });
    const result = await f.service.read("batch");
    expect(result.availableNodeSlots).toBe(5);
    expect(result.nodes[0]?.memoryAvailableSlots).toBeNull();
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "awaiting_refill" }));
  });
  it.each([
    ["runner_not_online", { state: "offline" }],
    [
      "metrics_stale",
      {
        resourceSnapshot: { ...runner().resourceSnapshot!, observedAt: "2026-10-25T07:00:00.000Z" },
      },
    ],
    [
      "cpu_limit_exceeded",
      { resourceSnapshot: { ...runner().resourceSnapshot!, cpuUtilizationPercent: 95 } },
    ],
    [
      "memory_limit_exceeded",
      { resourceSnapshot: { ...runner().resourceSnapshot!, memoryUtilizationPercent: 95 } },
    ],
    [
      "load_limit_exceeded",
      { resourceSnapshot: { ...runner().resourceSnapshot!, loadAverage1m: 32 } },
    ],
    ["capacity_exhausted", { busySlots: 10 }],
  ] as const)("reports %s without inferring a different cause", async (code, overrides) => {
    const f = fixture({
      nodes: [{ runner: runner(overrides), reservedSlots: 0, batchReservedSlots: 0 }],
    });
    const result = await f.service.read("batch");
    expect(result.nodes[0]?.reasons).toContainEqual(expect.objectContaining({ code }));
    expect(result.availableNodeSlots).toBe(0);
    expect(result.reasons.some((reason) => reason.code === "awaiting_refill")).toBe(false);
  });
  it("reports missing resource metrics", async () => {
    const node = runner();
    delete node.resourceSnapshot;
    const result = await fixture({
      nodes: [{ runner: node, reservedSlots: 0, batchReservedSlots: 0 }],
    }).service.read("batch");
    expect(result.nodes[0]?.reasons.map((reason) => reason.code)).toContain("metrics_unavailable");
  });
  it("distinguishes assigned work from running cases when the task is already at its cap", async () => {
    const result = await fixture({ runningRuns: 5, assignedRuns: 35 }).service.read("batch");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["waiting_claim", "batch_limit"]);
  });
  it("reports the shared project limit even when nodes have free slots", async () => {
    const result = await fixture({ projectActiveRuns: 128 }).service.read("batch");
    expect(result.reasons.map((reason) => reason.code)).toContain("project_limit");
    expect(result.reasons.map((reason) => reason.code)).not.toContain("awaiting_refill");
  });
  it.each([
    ["round_recovery", { readyRuns: 0, heldRuns: 10, recoveryPending: true }],
    ["round_barrier", { readyRuns: 0, heldRuns: 10 }],
    ["no_queued_work", { readyRuns: 0 }],
    ["remaining_work", { readyRuns: 2 }],
    ["no_runners", { nodes: [] }],
  ] satisfies Array<[string, Partial<ConcurrencySnapshot>]>)(
    "explains %s",
    async (code, overrides) => {
      const result = await fixture(overrides).service.read("batch");
      expect(result.reasons.map((reason) => reason.code)).toContain(code);
    },
  );
  it("explains missing DDT capabilities and labels without exposing Runner credentials", async () => {
    const f = fixture({ requiredCapabilities: ["adapter:ddt-case-id-v1"] });
    f.snapshot.batch.policy!.runnerLabels = ["required-label"];
    const result = await f.service.read("batch");
    expect(result.nodes[0]?.reasons.map((reason) => reason.code)).toEqual([
      "capability_missing",
      "labels_missing",
    ]);
    expect(result.availableNodeSlots).toBe(0);
    expect(JSON.stringify(result)).not.toContain("credentialVersion");
  });
  it("rejects a missing or inaccessible batch and preserves reader failures", async () => {
    const f = fixture();
    f.readConcurrencySnapshot.mockResolvedValueOnce(null);
    await expect(f.service.read("foreign", [])).rejects.toMatchObject({
      code: "RUN_BATCH_NOT_FOUND",
    });
    const failure = new Error("reader timeout");
    f.readConcurrencySnapshot.mockRejectedValueOnce(failure);
    await expect(f.service.read("batch")).rejects.toBe(failure);
  });
});
