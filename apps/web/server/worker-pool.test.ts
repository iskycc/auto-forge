import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundWorkerPool } from "./worker-pool";
import type { WorkRequest } from "./work-protocol";

const workers = vi.hoisted(() => [] as Array<EventEmitter & { requests: WorkRequest[] }>);
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
