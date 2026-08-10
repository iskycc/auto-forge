import type { JobQueuePort, WorkerLogger } from "@autoforge/application";
import { jobEnvelopeSchema, type JobEnvelope } from "@autoforge/contracts";
import type { PostgresDatabaseHandle } from "@autoforge/db";

type ClaimedOutboxRow = {
  message_id: string;
  payload_json: JobEnvelope | string;
  publish_attempts: number;
  maximum_publish_attempts: number;
};

export class PostgresOutboxRelay {
  constructor(
    private readonly database: PostgresDatabaseHandle,
    private readonly queue: Pick<JobQueuePort, "publish">,
    private readonly options: {
      workerId: string;
      leaseDurationMs: number;
      pollIntervalMs: number;
      batchSize: number;
    },
    private readonly logger: WorkerLogger,
  ) {
    if (options.batchSize < 1 || options.batchSize > 256) {
      throw new Error("Outbox relay batch size must be between 1 and 256.");
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.database.ready;
    while (!signal.aborted) {
      const now = new Date();
      const relayed = await this.relayOnce(now);
      if (relayed === 0) await delay(this.options.pollIntervalMs, signal);
    }
  }

  async relayOnce(now: Date): Promise<number> {
    const leaseExpiresAt = new Date(now.getTime() + this.options.leaseDurationMs);
    const result = await this.database.pool.query<ClaimedOutboxRow>(
      `WITH candidates AS (
         SELECT message_id
         FROM transactional_outbox
         WHERE published_at IS NULL
           AND failed_at IS NULL
           AND available_at <= $1
           AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
         ORDER BY available_at, created_at, message_id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE transactional_outbox AS outbox
       SET lease_owner = $3,
           lease_expires_at = $4,
           publish_attempts = outbox.publish_attempts + 1
       FROM candidates
       WHERE outbox.message_id = candidates.message_id
       RETURNING outbox.message_id, outbox.payload_json, outbox.publish_attempts,
                 outbox.maximum_publish_attempts`,
      [
        now.toISOString(),
        this.options.batchSize,
        this.options.workerId,
        leaseExpiresAt.toISOString(),
      ],
    );
    let published = 0;
    for (const row of result.rows) {
      try {
        const payload =
          typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
        const job = jobEnvelopeSchema.parse(payload);
        await this.queue.publish(job);
        const acknowledged = await this.database.pool.query(
          `UPDATE transactional_outbox
           SET published_at = $1, lease_owner = NULL, lease_expires_at = NULL,
               last_error_summary = NULL
           WHERE message_id = $2 AND lease_owner = $3 AND published_at IS NULL`,
          [now.toISOString(), row.message_id, this.options.workerId],
        );
        if (acknowledged.rowCount === 1) published += 1;
      } catch (error) {
        await this.recordFailure(row, error, now);
      }
    }
    return published;
  }

  private async recordFailure(row: ClaimedOutboxRow, error: unknown, now: Date): Promise<void> {
    const summary = (error instanceof Error ? error.message : "Unknown outbox failure.").slice(
      0,
      2_048,
    );
    const exhausted = row.publish_attempts >= row.maximum_publish_attempts;
    const retryAt = new Date(
      now.getTime() + Math.min(60_000, 1_000 * 2 ** Math.max(0, row.publish_attempts - 1)),
    );
    await this.database.pool.query(
      `UPDATE transactional_outbox
       SET lease_owner = NULL, lease_expires_at = NULL, last_error_summary = $1,
           available_at = $2, failed_at = CASE WHEN $3 THEN $4 ELSE NULL END
       WHERE message_id = $5 AND lease_owner = $6 AND published_at IS NULL`,
      [
        summary,
        retryAt.toISOString(),
        exhausted,
        now.toISOString(),
        row.message_id,
        this.options.workerId,
      ],
    );
    this.logger.error("outbox publish failed", {
      messageId: row.message_id,
      exhausted,
      error: summary,
    });
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => finish();
    const timeout = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
