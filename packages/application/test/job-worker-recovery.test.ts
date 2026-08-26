import type { JobEnvelope } from "@autoforge/contracts";
import { describe, expect, it, vi } from "vitest";

import type { JobQueuePort } from "../src/ports";
import { JobWorker } from "../src/run-job-worker";
import { runWithTransientRecovery } from "../src/transient-recovery";

describe("Lite-compatible job worker recovery", () => {
  it("resumes queue consumption after a transient claim failure", async () => {
    const controller = new AbortController();
    const queue = recoveryQueue();
    const handler = vi.fn(async () => controller.abort());
    const worker = new JobWorker(
      queue,
      { "jar-import": handler },
      { now: () => new Date("2026-08-24T00:00:00.000Z") },
      {
        workerId: "lite-worker",
        concurrency: 1,
        leaseDurationMs: 30_000,
        minimumPollMs: 1,
        maximumPollMs: 2,
      },
      { info: vi.fn(), error: vi.fn() },
    );

    await runWithTransientRecovery(
      controller.signal,
      () => worker.run(controller.signal),
      { info: vi.fn(), error: vi.fn() },
      { operationName: "Lite embedded job worker", initialDelayMs: 1, maximumDelayMs: 1 },
    );

    expect(queue.claim).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
    expect(queue.acknowledge).toHaveBeenCalledOnce();
  });

  it("keeps restarting after the normal limit while the failure remains recoverable", async () => {
    const controller = new AbortController();
    const logger = { info: vi.fn(), error: vi.fn() };
    const sqliteBusy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const operation = vi.fn(async () => {
      if (operation.mock.calls.length <= 3) throw sqliteBusy;
      controller.abort();
    });

    await runWithTransientRecovery(controller.signal, operation, logger, {
      operationName: "Lite embedded job worker",
      maximumConsecutiveFailures: 2,
      initialDelayMs: 1,
      maximumDelayMs: 1,
      shouldKeepRecovering: (error) => error === sqliteBusy,
    });

    expect(operation).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledTimes(3);
  });

  it("surfaces an in-flight persistence failure even when capacity remains", async () => {
    const sqliteBusy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const queue = failingCompletionQueue(sqliteBusy);
    const worker = new JobWorker(
      queue,
      { "jar-import": async () => undefined },
      { now: () => new Date("2026-08-24T00:00:00.000Z") },
      {
        workerId: "lite-worker",
        concurrency: 2,
        leaseDurationMs: 30_000,
        minimumPollMs: 1,
        maximumPollMs: 2,
      },
      { info: vi.fn(), error: vi.fn() },
    );

    await expect(worker.run(AbortSignal.timeout(100))).rejects.toBe(sqliteBusy);
    expect(queue.claim).toHaveBeenCalledTimes(2);
    expect(queue.acknowledge).toHaveBeenCalledOnce();
    expect(queue.reject).toHaveBeenCalledOnce();
  });
});

function recoveryQueue(): JobQueuePort & {
  claim: ReturnType<typeof vi.fn<JobQueuePort["claim"]>>;
  acknowledge: ReturnType<typeof vi.fn<JobQueuePort["acknowledge"]>>;
} {
  const job: JobEnvelope = {
    schemaVersion: 1,
    messageId: "message-1",
    runId: "import-1",
    attempt: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    priority: 0,
    deduplicationKey: "jar-import:import-1",
    kind: "jar-import",
    payload: { jobId: "import-1" },
  };
  const claim = vi
    .fn<JobQueuePort["claim"]>()
    .mockRejectedValueOnce(new Error("database is busy"))
    .mockResolvedValueOnce([
      {
        job,
        deliveryId: job.messageId,
        deliveryAttempt: 1,
        leaseExpiresAt: "2026-08-24T00:00:30.000Z",
      },
    ]);
  const acknowledge = vi.fn<JobQueuePort["acknowledge"]>(async () => undefined);
  return {
    publish: async () => "published",
    claim,
    renew: async () => true,
    acknowledge,
    reject: async () => "retrying",
    recoverExpired: async () => 0,
    depth: async () => ({ available: 0, leased: 0, deadLetter: 0 }),
    ready: async () => undefined,
    close: async () => undefined,
  };
}

function failingCompletionQueue(error: Error): JobQueuePort & {
  claim: ReturnType<typeof vi.fn<JobQueuePort["claim"]>>;
  acknowledge: ReturnType<typeof vi.fn<JobQueuePort["acknowledge"]>>;
  reject: ReturnType<typeof vi.fn<JobQueuePort["reject"]>>;
} {
  const job: JobEnvelope = {
    schemaVersion: 1,
    messageId: "message-completion",
    runId: "import-completion",
    attempt: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    priority: 0,
    deduplicationKey: "jar-import:import-completion",
    kind: "jar-import",
    payload: { jobId: "import-completion" },
  };
  const claim = vi
    .fn<JobQueuePort["claim"]>()
    .mockResolvedValueOnce([
      {
        job,
        deliveryId: job.messageId,
        deliveryAttempt: 1,
        leaseExpiresAt: "2026-08-24T00:00:30.000Z",
      },
    ])
    .mockImplementationOnce(async () => {
      await Promise.resolve();
      return [];
    })
    .mockResolvedValue([]);
  const acknowledge = vi.fn<JobQueuePort["acknowledge"]>(async () => {
    throw error;
  });
  const reject = vi.fn<JobQueuePort["reject"]>(async () => {
    throw error;
  });
  return {
    publish: async () => "published",
    claim,
    renew: async () => true,
    acknowledge,
    reject,
    recoverExpired: async () => 0,
    depth: async () => ({ available: 0, leased: 1, deadLetter: 0 }),
    ready: async () => undefined,
    close: async () => undefined,
  };
}
