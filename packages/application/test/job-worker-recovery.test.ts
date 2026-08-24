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
