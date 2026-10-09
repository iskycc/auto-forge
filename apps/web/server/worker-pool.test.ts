import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundWorkerPool, WorkerPool } from "./worker-pool";
import { webResourcePlan } from "../src/lib/worker-sizing";
import type { WorkRequest } from "./work-protocol";

const workers = vi.hoisted(() => [] as Array<EventEmitter & { requests: WorkRequest[] }>);
vi.mock("./diagnostic-read-process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    DiagnosticReadProcess: class extends EventEmitter {
      requests: WorkRequest[] = [];
      constructor() {
        super();
        workers.push(this);
      }
      postMessage(request: WorkRequest) {
        this.requests.push(request);
      }
      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      requests: WorkRequest[] = [];
      constructor() {
        super();
        workers.push(this);
      }
      postMessage(request: WorkRequest) {
        this.requests.push(request);
      }
      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  workers.length = 0;
});

function pool() {
  return new BackgroundWorkerPool(
    {
      mode: "lite",
      dataDirectory: "unused",
      migrationsFolder: "unused",
      attemptLogsDirectory: "unused",
      caseExecutionTimeoutSeconds: 60,
      artifactCollectionEnabled: false,
      scheduler: {
        maximumCpuUtilizationPercent: 90,
        maximumMemoryUtilizationPercent: 90,
        maximumLoadPerCpu: 2,
        metricsMaximumAgeSeconds: 60,
        projectMaximumConcurrency: 500,
        priorityAgingIntervalMinutes: 1,
      },
    },
    { lanes: 1, heapMb: 128, shutdownGraceMs: 1 },
  );
}

describe("work thread recovery", () => {
  it.each(["lite", "full"] as const)(
    "keeps blocked %s diagnostics away from lease renewal and bounds their queue",
    async (mode) => {
      const executor = diagnosticPool(mode);
      try {
        const logs = executor.listSchedulingEvents({ batchId: "batch", limit: 500 });
        const samples = executor.readRunnerResourceSamples({
          runnerId: "runner",
          since: "start",
          until: "end",
        });
        await expect(
          executor.listSchedulingEvents({ batchId: "batch", limit: 500 }),
        ).rejects.toMatchObject({ code: "PLATFORM_BUSY" });
        const renewal = executor.renewLease({ leaseId: "lease" });
        const reader = workers[0]!;
        const control = workers[1]!;
        expect(control).not.toBe(reader);
        expect(control.requests[0]!.task.kind).toBe("renew-lease");
        control.emit("message", { id: control.requests[0]!.id, ok: true, value: { version: 2 } });
        await expect(renewal).resolves.toEqual({ version: 2 });
        reader.emit("message", { id: reader.requests[0]!.id, ok: true, value: { items: [] } });
        reader.emit("message", { id: reader.requests[1]!.id, ok: true, value: [] });
        await expect(logs).resolves.toEqual({ items: [] });
        await expect(samples).resolves.toEqual([]);
      } finally {
        await executor.close();
      }
    },
  );

  it("interrupts a timed-out read, rejects waiting diagnostics and allows a fresh reader", async () => {
    vi.useFakeTimers();
    const executor = diagnosticPool("lite");
    try {
      const stale = expect(
        executor.listSchedulingEvents({ batchId: "batch", limit: 500 }),
      ).rejects.toMatchObject({ code: "PLATFORM_BUSY" });
      const queued = expect(
        executor.readRunnerResourceSamples({ runnerId: "runner" }),
      ).rejects.toMatchObject({ code: "PLATFORM_BUSY" });
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all([stale, queued]);
      const fresh = executor.listSchedulingEvents({ batchId: "batch", limit: 500 });
      const reader = workers.at(-1)!;
      expect(workers).toHaveLength(2);
      reader.emit("message", { id: reader.requests[0]!.id, ok: true, value: { items: [] } });
      await expect(fresh).resolves.toEqual({ items: [] });
    } finally {
      await executor.close();
    }
  });
  it("preserves the failing maintenance operation and database code across worker RPC", async () => {
    const executor = pool();
    try {
      const context = {
        operation: "platform-maintenance.retention",
        database: "sqlite",
        errorCode: "SQLITE_BUSY",
        requestId: "work-9",
      };
      const pending = expect(executor.runPlatformMaintenance("retention")).rejects.toMatchObject({
        code: "SQLITE_BUSY",
        runtimeContext: context,
      });
      const request = workers[0]!.requests[0]!;
      workers[0]!.emit("message", {
        id: request.id,
        ok: false,
        error: {
          name: "SqliteError",
          message: "database locked",
          code: "SQLITE_BUSY",
          runtimeContext: context,
        },
      });
      await pending;
    } finally {
      await executor.close();
    }
  });
  it("rejects unfinished requests even on exit zero, then accepts work in a replacement thread", async () => {
    const executor = pool();
    try {
      const unfinished = expect(executor.runPlatformMaintenance("retention")).rejects.toThrow(
        "exit code 0",
      );
      workers[0]!.emit("exit", 0);
      await unfinished;
      const replacement = executor.runPlatformMaintenance("notifications");
      expect(workers).toHaveLength(2);
      const worker = workers[1]!;
      worker.emit("message", { id: worker.requests[0]!.id, ok: true, value: true });
      await expect(replacement).resolves.toBe(true);
    } finally {
      await executor.close();
    }
  });

  it("rejects new work between an error and exit without posting to the failed thread", async () => {
    const executor = pool();
    try {
      const failed = expect(executor.runPlatformMaintenance("retention")).rejects.toThrow(
        "worker failed",
      );
      const original = workers[0]!;
      original.emit("error", new Error("worker failed"));
      await failed;
      await expect(executor.runPlatformMaintenance("notifications")).rejects.toThrow("recovering");
      expect(original.requests).toHaveLength(1);
      original.emit("exit", 1);
      const resumed = executor.runPlatformMaintenance("notifications");
      const replacement = workers[1]!;
      original.emit("exit", 1);
      replacement.emit("message", { id: replacement.requests[0]!.id, ok: true, value: true });
      await expect(resumed).resolves.toBe(true);
    } finally {
      await executor.close();
    }
  });
});

function diagnosticPool(mode: "lite" | "full") {
  return new WorkerPool(
    {
      mode,
      dataDirectory: "unused",
      migrationsFolder: "unused",
      attemptLogsDirectory: "unused",
      caseExecutionTimeoutSeconds: 60,
      artifactCollectionEnabled: false,
      scheduler: {
        maximumCpuUtilizationPercent: 90,
        maximumMemoryUtilizationPercent: 90,
        maximumLoadPerCpu: 2,
        metricsMaximumAgeSeconds: 60,
        projectMaximumConcurrency: 500,
        priorityAgingIntervalMinutes: 1,
      },
    },
    1,
    1,
    webResourcePlan({ cpuCapacity: 1, memoryCapacityBytes: 4 * 1024 ** 3 }, mode),
  );
}
