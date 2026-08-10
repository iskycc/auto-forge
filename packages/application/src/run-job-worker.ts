import type { JobEnvelope } from "@autoforge/contracts";

import type { Clock, JobQueuePort } from "./ports";

export type JobHandler = (job: JobEnvelope, signal: AbortSignal) => Promise<void>;

export type WorkerLogger = {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
};

export class JobWorker {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly queue: JobQueuePort,
    private readonly handlers: Partial<Record<JobEnvelope["kind"], JobHandler>>,
    private readonly clock: Clock,
    private readonly options: {
      workerId: string;
      concurrency: number;
      leaseDurationMs: number;
      minimumPollMs: number;
      maximumPollMs: number;
    },
    private readonly logger: WorkerLogger,
  ) {
    if (options.concurrency < 1 || options.concurrency > 256) {
      throw new Error("Worker concurrency must be between 1 and 256.");
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.queue.ready();
    let pollDelay = this.options.minimumPollMs;
    while (!signal.aborted) {
      const available = this.options.concurrency - this.inFlight.size;
      if (available <= 0) {
        await Promise.race(this.inFlight);
        continue;
      }
      const now = this.clock.now();
      const claimed = await this.queue.claim({
        workerId: this.options.workerId,
        now: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + this.options.leaseDurationMs).toISOString(),
        limit: available,
      });
      if (claimed.length === 0) {
        await delay(pollDelay, signal);
        pollDelay = Math.min(this.options.maximumPollMs, pollDelay * 2);
        continue;
      }
      pollDelay = this.options.minimumPollMs;
      for (const delivery of claimed) {
        const processing = this.process(delivery, signal).finally(() => {
          this.inFlight.delete(processing);
        });
        this.inFlight.add(processing);
      }
    }
    await Promise.allSettled(this.inFlight);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  private async process(
    delivery: Awaited<ReturnType<JobQueuePort["claim"]>>[number],
    parentSignal: AbortSignal,
  ): Promise<void> {
    const handler = this.handlers[delivery.job.kind];
    if (!handler) {
      await this.reject(delivery, new Error(`No handler is registered for ${delivery.job.kind}.`));
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", abort, { once: true });
    const renewal = setInterval(
      () => {
        const now = this.clock.now();
        void this.queue
          .renew({
            workerId: this.options.workerId,
            deliveryId: delivery.deliveryId,
            now: now.toISOString(),
            leaseExpiresAt: new Date(now.getTime() + this.options.leaseDurationMs).toISOString(),
          })
          .then((renewed) => {
            if (!renewed) controller.abort(new Error("Job lease was lost."));
          })
          .catch((error: unknown) => {
            this.logger.error("job lease renewal failed", {
              messageId: delivery.job.messageId,
              error: error instanceof Error ? error.message : "unknown error",
            });
          });
      },
      Math.max(1_000, Math.floor(this.options.leaseDurationMs / 3)),
    );
    try {
      await handler(delivery.job, controller.signal);
      await this.queue.acknowledge({
        workerId: this.options.workerId,
        deliveryId: delivery.deliveryId,
        acknowledgedAt: this.clock.now().toISOString(),
      });
      this.logger.info("job completed", {
        messageId: delivery.job.messageId,
        runId: delivery.job.runId,
        kind: delivery.job.kind,
      });
    } catch (error) {
      await this.reject(delivery, error);
    } finally {
      clearInterval(renewal);
      parentSignal.removeEventListener("abort", abort);
    }
  }

  private async reject(
    delivery: Awaited<ReturnType<JobQueuePort["claim"]>>[number],
    error: unknown,
  ): Promise<void> {
    const rejectedAt = this.clock.now();
    const summary = error instanceof Error ? error.message : "Unknown job failure.";
    const disposition = await this.queue.reject({
      workerId: this.options.workerId,
      deliveryId: delivery.deliveryId,
      errorCode: "JOB_HANDLER_FAILED",
      errorSummary: summary.slice(0, 2_048),
      retryAt: new Date(
        rejectedAt.getTime() + Math.min(60_000, 1_000 * 2 ** (delivery.deliveryAttempt - 1)),
      ).toISOString(),
      rejectedAt: rejectedAt.toISOString(),
    });
    this.logger.error("job failed", {
      messageId: delivery.job.messageId,
      runId: delivery.job.runId,
      kind: delivery.job.kind,
      disposition,
      error: summary,
    });
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
