import { describe, expect, it, vi } from "vitest";

import type { ClaimedJob, JobQueuePort } from "../src/ports";
import { JobWorker, type JobHandler } from "../src/run-job-worker";

describe("JobWorker", () => {
  it("acknowledges a completed job and drains after shutdown", async () => {
    const delivery = dispatchDelivery();
    const queue = new FakeQueue([delivery]);
    const handled: string[] = [];
    const abort = new AbortController();
    const worker = createWorker(queue, async (job) => {
      handled.push(job.messageId);
      abort.abort();
    });

    await worker.run(abort.signal);

    expect(handled).toEqual([delivery.job.messageId]);
    expect(queue.acknowledged).toEqual([delivery.deliveryId]);
    expect(queue.rejected).toEqual([]);
  });

  it("releases a failed delivery for bounded retry", async () => {
    const delivery = dispatchDelivery();
    const queue = new FakeQueue([delivery]);
    const abort = new AbortController();
    queue.afterReject = () => abort.abort();
    const worker = createWorker(queue, async () => {
      throw new Error("database unavailable");
    });

    await worker.run(abort.signal);

    expect(queue.acknowledged).toEqual([]);
    expect(queue.rejected).toEqual([delivery.deliveryId]);
  });

  it("keeps the minimum poll cadence for queues with blocking claims", async () => {
    vi.useFakeTimers();
    try {
      const queue = new FakeQueue([]);
      queue.blockingClaim = true;
      const abort = new AbortController();
      const worker = createWorker(queue, vi.fn());
      const running = worker.run(abort.signal);
      // minimumPollMs=1：阻塞式队列的每个空轮询周期只有一个 1ms 定时器。
      await vi.advanceTimersByTimeAsync(100);
      abort.abort();
      await running;

      expect(queue.claimCount).toBeGreaterThanOrEqual(90);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off empty polls for non-blocking queues", async () => {
    vi.useFakeTimers();
    try {
      const queue = new FakeQueue([]);
      const abort = new AbortController();
      const worker = createWorker(queue, vi.fn());
      const running = worker.run(abort.signal);
      // 非阻塞队列退避 1→2→2…（maximumPollMs=2），100ms 窗口的领取次数约为一半。
      await vi.advanceTimersByTimeAsync(100);
      abort.abort();
      await running;

      expect(queue.claimCount).toBeLessThanOrEqual(60);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createWorker(queue: JobQueuePort, handler: JobHandler) {
  return new JobWorker(
    queue,
    { "dispatch-run": handler },
    { now: () => new Date("2026-08-10T00:00:00.000Z") },
    {
      workerId: "worker-1",
      concurrency: 1,
      leaseDurationMs: 30_000,
      minimumPollMs: 1,
      maximumPollMs: 2,
    },
    { info: vi.fn(), error: vi.fn() },
  );
}

function dispatchDelivery(): ClaimedJob {
  return {
    job: {
      schemaVersion: 1,
      messageId: "message-1",
      runId: "batch-1",
      attempt: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      priority: 0,
      deduplicationKey: "dispatch-batch:batch-1:1",
      kind: "dispatch-run",
      payload: { batchId: "batch-1" },
    },
    deliveryId: "delivery-1",
    leaseExpiresAt: "2026-08-10T00:00:30.000Z",
    deliveryAttempt: 1,
  };
}

class FakeQueue implements JobQueuePort {
  readonly acknowledged: string[] = [];
  readonly rejected: string[] = [];
  blockingClaim?: boolean;
  afterReject?: () => void;
  claimCount = 0;
  private claimed = false;

  constructor(private readonly deliveries: ClaimedJob[]) {}

  async publish() {
    return "published" as const;
  }

  async claim(): Promise<ClaimedJob[]> {
    this.claimCount += 1;
    if (this.claimed) return [];
    this.claimed = true;
    return this.deliveries;
  }

  async renew(): Promise<boolean> {
    return true;
  }

  async acknowledge(input: { deliveryId: string }): Promise<void> {
    this.acknowledged.push(input.deliveryId);
  }

  async reject(input: { deliveryId: string }): Promise<"retrying"> {
    this.rejected.push(input.deliveryId);
    this.afterReject?.();
    return "retrying";
  }

  async recoverExpired(): Promise<number> {
    return 0;
  }

  async depth() {
    return { available: 0, leased: 0, deadLetter: 0 };
  }

  async ready(): Promise<void> {}
  async close(): Promise<void> {}
}
