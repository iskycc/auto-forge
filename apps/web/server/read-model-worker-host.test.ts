import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadModelWorkerHost } from "./read-model-worker-host";

const state = vi.hoisted(() => ({
  workers: [] as EventEmitter[],
  priority: {
    signal: new SharedArrayBuffer(8),
    report: vi.fn(),
    observeDatabaseContention: vi.fn(),
  },
}));
vi.mock("../src/lib/runtime-priority.ts", () => ({ runtimePriority: () => state.priority }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        state.workers.push(this);
      }
      postMessage() {
        this.emit("exit", 0);
      }
    },
  };
});
afterEach(() => {
  state.workers.length = 0;
  vi.clearAllMocks();
});

describe("background snapshot contention reporting", () => {
  it.each(["lite", "full"] as const)(
    "%s distinguishes a retryable lock deferral from a failed refresh",
    async (mode) => {
      const errors = vi.fn();
      const host = new ReadModelWorkerHost(
        {
          ...(mode === "lite" ? { mode, databasePath: "unused" } : { mode, databaseUrl: "unused" }),
          migrationsFolder: "unused",
        },
        errors,
      );
      try {
        const worker = state.workers[0]!;
        const context = {
          operation: "snapshot.build.case_directory",
          database: mode === "lite" ? "sqlite" : "postgresql",
          errorCode: mode === "lite" ? "SQLITE_BUSY" : "55P03",
        };
        worker.emit("message", { kind: "database_contention", context });
        expect(state.priority.observeDatabaseContention).toHaveBeenCalledWith(context);
        expect(state.priority.observeDatabaseContention).toHaveBeenCalledOnce();
        expect(state.priority.report).not.toHaveBeenCalled();
        worker.emit("message", { kind: "background_refresh" });
        expect(state.priority.report).toHaveBeenCalledWith("background_refresh", {
          operation: "snapshot.worker",
          database: mode === "lite" ? "sqlite" : "postgresql",
        });
        worker.emit("error", new Error("thread failed"));
        expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: "thread failed" }));
      } finally {
        await host.close();
      }
    },
  );
});
