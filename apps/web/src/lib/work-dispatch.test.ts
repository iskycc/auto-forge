import { describe, expect, it, vi } from "vitest";

import type { ExecutionControlRepository, RunBatchSchedulingPort } from "@autoforge/application";

import { CoalescingSchedulingPort, workerBackedExecutionControlRepository } from "./work-dispatch";
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
    const second = scheduling.scheduleForRunner("runner-1", 8);
    expect(first).toBe(second);
    expect(local.scheduleForRunner).toHaveBeenCalledOnce();

    release();
    await Promise.all([first, second]);
    expect(local.scheduleForRunner).toHaveBeenCalledTimes(2);
    await scheduling.scheduleForRunner("runner-1", 8);
    expect(local.scheduleForRunner).toHaveBeenCalledTimes(3);
  });
});

describe("execution control work dispatch", () => {
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
