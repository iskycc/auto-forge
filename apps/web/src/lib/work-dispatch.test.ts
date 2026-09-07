import { describe, expect, it, vi } from "vitest";

import type {
  ExecutionControlRepository,
  RunBatchSchedulingPort,
  RunBatchSchedulingService,
} from "@autoforge/application";

import {
  CoalescingSchedulingPort,
  workerBackedExecutionControlRepository,
  prioritizedExecutionControlRepository,
  workerBackedBatchCreation,
} from "./work-dispatch";
import type { WorkDispatcher } from "./work-runtime";

describe("scheduling coalescing", () => {
  it("merges a burst into a leading and one trailing scan without losing a refill", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const local = {
      schedule: vi.fn().mockReturnValue(gate),
      scheduleForRunner: vi.fn().mockReturnValue(gate),
    } satisfies RunBatchSchedulingPort;
    const scheduling = new CoalescingSchedulingPort(local, undefined);

    const first = scheduling.scheduleForRunner("runner-1", 8);
    const second = scheduling.scheduleForRunner("runner-1", 8, 1);
    expect(first).toBe(second);
    expect(local.scheduleForRunner).toHaveBeenCalledOnce();
    expect(local.scheduleForRunner).toHaveBeenNthCalledWith(1, "runner-1", 8, undefined);

    release();
    await Promise.all([first, second]);
    expect(local.scheduleForRunner).toHaveBeenCalledTimes(2);
    expect(local.scheduleForRunner).toHaveBeenNthCalledWith(2, "runner-1", 8, 1);
    await scheduling.scheduleForRunner("runner-1", 8);
    expect(local.scheduleForRunner).toHaveBeenCalledTimes(3);
  });
});

describe("execution control work dispatch", () => {
  it("creates a Lite batch in the worker while keeping reads bound to their repository", async () => {
    const local = {
      id: "local-summary",
      create: vi.fn(),
      getSummary() {
        return Promise.resolve(this.id);
      },
    };
    const createBatch = vi.fn().mockResolvedValue({ id: "worker-batch" });
    const dispatcher = { createBatch } as unknown as WorkDispatcher;
    const service = local as unknown as RunBatchSchedulingService;
    const isolated = workerBackedBatchCreation(service, dispatcher);
    await expect(isolated.create({ suiteId: "suite" })).resolves.toEqual({ id: "worker-batch" });
    expect(createBatch).toHaveBeenCalledWith({ suiteId: "suite" });
    expect(local.create).not.toHaveBeenCalled();
    await expect(isolated.getSummary("batch")).resolves.toBe("local-summary");
    expect(workerBackedBatchCreation(service, undefined)).toBe(service);
  });
  it("tracks actual Full control work while allowing dependent snapshot reads to progress", async () => {
    const finish = vi.fn();
    const begin = vi.fn(() => finish);
    const local = {
      listLogChunks: vi.fn(async () => ({ items: [] })),
      reconcile: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    } as unknown as ExecutionControlRepository;
    const repository = prioritizedExecutionControlRepository(local, begin);
    await repository.listLogChunks({
      attemptId: "one",
      stream: "stdout",
      afterSequence: -1,
      limit: 1,
    });
    expect(begin).not.toHaveBeenCalled();
    await expect(
      repository.reconcile({
        runnerId: "runner",
        now: "2026-09-07T00:00:00.000Z",
        request: { schemaVersion: 1, requestId: "reconcile", attempts: [] },
      }),
    ).rejects.toThrow("database unavailable");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });
  it("moves whole-batch termination away from the Web event loop", async () => {
    const input = {
      batchId: "batch-1",
      actorId: "operator-1",
      reason: "maintenance",
      eventId: "event-1",
      requestedAt: "2026-08-21T00:00:00.000Z",
    };
    const localTerminate = vi.fn().mockResolvedValue(0);
    const workerTerminate = vi.fn().mockResolvedValue(42);
    const local = { terminateBatch: localTerminate } as unknown as ExecutionControlRepository;
    const dispatcher = { terminateBatch: workerTerminate } as unknown as WorkDispatcher;
    const repository = workerBackedExecutionControlRepository(local, dispatcher);

    await expect(repository.terminateBatch(input)).resolves.toBe(42);
    expect(workerTerminate).toHaveBeenCalledWith(input);
    expect(localTerminate).not.toHaveBeenCalled();
  });

  it("moves log authorization and persistence to a dedicated worker lane", async () => {
    const input = {
      runnerId: "runner-1",
      attemptId: "attempt-1",
      leaseTokenHash: "lease-hash",
      receivedAt: "2026-08-21T00:00:00.000Z",
      chunks: [
        {
          stream: "stdout" as const,
          sequence: 0,
          content: "ready\n",
          recordedAt: "2026-08-21T00:00:00.000Z",
        },
      ],
    };
    const localAppend = vi.fn().mockResolvedValue({ acknowledgedSequence: { stdout: -1 } });
    const workerAppend = vi.fn().mockResolvedValue({ acknowledgedSequence: { stdout: 0 } });
    const local = { appendLogChunks: localAppend } as unknown as ExecutionControlRepository;
    const dispatcher = { appendAttemptLogChunks: workerAppend } as unknown as WorkDispatcher;
    const repository = workerBackedExecutionControlRepository(local, dispatcher);

    await expect(repository.appendLogChunks(input)).resolves.toEqual({
      acknowledgedSequence: { stdout: 0 },
    });
    expect(workerAppend).toHaveBeenCalledWith(input);
    expect(localAppend).not.toHaveBeenCalled();
  });
});
