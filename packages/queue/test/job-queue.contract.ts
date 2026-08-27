import { JobWorker, type JobQueuePort } from "@autoforge/application";
import type { JobEnvelope } from "@autoforge/contracts";
import { describe, expect, it, vi } from "vitest";

export type JobQueueHarness = {
  queue: JobQueuePort;
  restart(): Promise<JobQueuePort>;
  dispose(): Promise<void>;
};

type HarnessFactory = (testId: string) => Promise<JobQueueHarness>;

export function jobQueueContract(adapterName: string, createHarness: HarnessFactory): void {
  describe(`${adapterName} contract`, () => {
    it("deduplicates messages and does not deliver them before their availability time", async () => {
      await withHarness(createHarness, "delay", async ({ queue }) => {
        const job = createJob("delay");
        const availableAt = timestamp(300);

        await expect(queue.publish(job, availableAt)).resolves.toBe("published");
        await expect(
          queue.publish({ ...job, messageId: "message-delay-duplicate" }, availableAt),
        ).resolves.toBe("duplicate");
        await expect(claim(queue, "worker-delay")).resolves.toEqual([]);

        await sleep(350);
        const [delivery] = await claimEventually(queue, "worker-delay");
        expect(delivery?.job.messageId).toBe(job.messageId);
        expect(delivery?.deliveryAttempt).toBe(1);
        await queue.acknowledge({
          workerId: "worker-delay",
          deliveryId: delivery?.deliveryId ?? "missing",
          acknowledgedAt: timestamp(),
        });
        await expect(queue.depth()).resolves.toEqual({
          available: 0,
          leased: 0,
          deadLetter: 0,
        });
      });
    });

    it("redelivers an unacknowledged job after a process restart and expired lease", async () => {
      await withHarness(createHarness, "restart", async (harness) => {
        const job = createJob("restart");
        await harness.queue.publish(job);
        const [first] = await claimEventually(harness.queue, "worker-before-crash", 200);
        expect(first?.deliveryAttempt).toBe(1);

        harness.queue = await harness.restart();
        await sleep(350);
        await harness.queue.recoverExpired(timestamp(), 10);
        const [redelivery] = await claimEventually(harness.queue, "worker-after-crash");
        expect(redelivery).toMatchObject({
          deliveryAttempt: 2,
          job: { messageId: job.messageId },
        });
        await harness.queue.acknowledge({
          workerId: "worker-after-crash",
          deliveryId: redelivery?.deliveryId ?? "missing",
          acknowledgedAt: timestamp(),
        });
      });
    });

    it("enforces delivery ownership", async () => {
      await withHarness(createHarness, "ownership", async ({ queue }) => {
        await queue.publish(createJob("ownership"));
        const [delivery] = await claimEventually(queue, "worker-owner");
        const deliveryId = delivery?.deliveryId ?? "missing";

        await expect(
          queue.renew({
            workerId: "worker-other",
            deliveryId,
            now: timestamp(),
            leaseExpiresAt: timestamp(1_000),
          }),
        ).resolves.toBe(false);
        await expect(
          queue.acknowledge({
            workerId: "worker-other",
            deliveryId,
            acknowledgedAt: timestamp(),
          }),
        ).rejects.toThrow("not owned");
        await queue.acknowledge({
          workerId: "worker-owner",
          deliveryId,
          acknowledgedAt: timestamp(),
        });
      });
    });

    it("moves a job to dead letter after the maximum delivery count", async () => {
      await withHarness(createHarness, "dead", async ({ queue }) => {
        await queue.publish(createJob("dead"));

        for (let attempt = 1; attempt <= 8; attempt += 1) {
          const [delivery] = await claimEventually(queue, "worker-dead");
          expect(delivery?.deliveryAttempt).toBe(attempt);
          const rejectedAt = timestamp();
          await expect(
            queue.reject({
              workerId: "worker-dead",
              deliveryId: delivery?.deliveryId ?? "missing",
              errorCode: "CONTRACT_FAILURE",
              errorSummary: "contract failure",
              retryAt: rejectedAt,
              rejectedAt,
            }),
          ).resolves.toBe(attempt === 8 ? "dead_letter" : "retrying");
        }

        await expect(queue.depth()).resolves.toEqual({
          available: 0,
          leased: 0,
          deadLetter: 1,
        });
        await expect(queue.listDeadLetters(10)).resolves.toEqual([
          expect.objectContaining({
            messageId: "message-dead",
            runId: "run-dead",
            kind: "dispatch-run",
            deliveryAttempts: 8,
            errorCode: "CONTRACT_FAILURE",
            errorSummary: "contract failure",
          }),
        ]);
        await expect(
          queue.redriveDeadLetters({ redrivenAt: timestamp(), limit: 10 }),
        ).resolves.toBe(1);
        const [redriven] = await claimEventually(queue, "worker-redrive");
        expect(redriven).toMatchObject({
          deliveryAttempt: 1,
          job: { messageId: "message-dead" },
        });
        let redelivery = redriven;
        for (let attempt = 1; attempt <= 8; attempt += 1) {
          expect(redelivery?.deliveryAttempt).toBe(attempt);
          const rejectedAt = timestamp();
          await expect(
            queue.reject({
              workerId: "worker-redrive",
              deliveryId: redelivery?.deliveryId ?? "missing",
              errorCode: "CONTRACT_FAILURE_AGAIN",
              errorSummary: "contract failure after redrive",
              retryAt: rejectedAt,
              rejectedAt,
            }),
          ).resolves.toBe(attempt === 8 ? "dead_letter" : "retrying");
          if (attempt < 8) [redelivery] = await claimEventually(queue, "worker-redrive");
        }
        await expect(queue.depth()).resolves.toEqual({
          available: 0,
          leased: 0,
          deadLetter: 1,
        });
      });
    });

    it("stops claiming and drains in-flight work during shutdown", async () => {
      await withHarness(createHarness, "drain", async ({ queue }) => {
        await queue.publish(createJob("drain"));
        const abort = new AbortController();
        let releaseHandler: () => void = () => {};
        const handlerFinished = new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        let notifyStarted: () => void = () => {};
        const handlerStarted = new Promise<void>((resolve) => {
          notifyStarted = resolve;
        });
        const worker = new JobWorker(
          queue,
          {
            "dispatch-run": async () => {
              notifyStarted();
              await handlerFinished;
            },
          },
          { now: () => new Date() },
          {
            workerId: "worker-drain",
            concurrency: 1,
            leaseDurationMs: 10_000,
            minimumPollMs: 5,
            maximumPollMs: 20,
          },
          { info: vi.fn(), error: vi.fn() },
        );

        let drained = false;
        const run = worker.run(abort.signal).then(() => {
          drained = true;
        });
        await handlerStarted;
        abort.abort();
        await sleep(20);
        expect(drained).toBe(false);
        releaseHandler();
        await run;
        await worker.close();
        await expect(queue.depth()).resolves.toEqual({
          available: 0,
          leased: 0,
          deadLetter: 0,
        });
      });
    });
  });
}

async function withHarness(
  createHarness: HarnessFactory,
  testId: string,
  verify: (harness: JobQueueHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness(testId);
  try {
    await verify(harness);
  } finally {
    await harness.dispose();
  }
}

function createJob(testId: string): JobEnvelope {
  return {
    schemaVersion: 1,
    messageId: `message-${testId}`,
    runId: `run-${testId}`,
    attempt: 1,
    createdAt: timestamp(),
    priority: 10,
    deduplicationKey: `dispatch:${testId}`,
    kind: "dispatch-run",
    payload: { batchId: `batch-${testId}` },
  };
}

async function claim(queue: JobQueuePort, workerId: string, leaseDurationMs: number = 2_000) {
  const now = new Date();
  return queue.claim({
    workerId,
    now: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    limit: 1,
  });
}

async function claimEventually(queue: JobQueuePort, workerId: string, leaseDurationMs?: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const deliveries = await claim(queue, workerId, leaseDurationMs);
    if (deliveries.length > 0) return deliveries;
    await sleep(25);
  }
  throw new Error(`Queue did not deliver a job to ${workerId} before the test deadline.`);
}

function timestamp(offsetMs: number = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
