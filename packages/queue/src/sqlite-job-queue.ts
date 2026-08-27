import type { ClaimedJob, DeadLetterJob, JobQueuePort } from "@autoforge/application";
import { jobEnvelopeSchema, type JobEnvelope } from "@autoforge/contracts";
import {
  retrySqliteLockContention,
  runSqliteWriteTransaction,
  type SqliteDatabaseHandle,
} from "@autoforge/db/sqlite";

type QueueJobRow = {
  message_id: string;
  run_id: string;
  attempt: number;
  schema_version: number;
  kind: JobEnvelope["kind"];
  payload_json: string;
  priority: number;
  deduplication_key: string;
  status: "available" | "leased" | "completed" | "dead_letter";
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  delivery_attempts: number;
  maximum_deliveries: number;
  created_at: string;
  updated_at: string;
  last_error_code: string | null;
  last_error_summary: string | null;
};

export class SqliteJobQueue implements JobQueuePort {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async publish(jobInput: JobEnvelope, availableAt: string = jobInput.createdAt) {
    const job = jobEnvelopeSchema.parse(jobInput);
    return retrySqliteLockContention(() =>
      runSqliteWriteTransaction(this.handle, () => {
        const existing = this.handle.client
          .prepare("SELECT message_id FROM queue_jobs WHERE deduplication_key = ?")
          .get(job.deduplicationKey) as { message_id: string } | undefined;
        if (existing) return "duplicate" as const;
        this.handle.client
          .prepare(
            `INSERT INTO queue_jobs
             (message_id, run_id, attempt, schema_version, kind, payload_json, priority,
              deduplication_key, status, available_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
          )
          .run(
            job.messageId,
            job.runId,
            job.attempt,
            job.schemaVersion,
            job.kind,
            JSON.stringify(job.payload),
            job.priority,
            job.deduplicationKey,
            availableAt,
            job.createdAt,
            job.createdAt,
          );
        return "published" as const;
      }),
    );
  }

  async claim(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<ClaimedJob[]> {
    validateClaim(input);
    const hasClaimableWork = await retrySqliteLockContention(() =>
      Boolean(
        this.handle.client
          .prepare(
            `SELECT 1 FROM queue_jobs
             WHERE (status = 'available' AND available_at <= ?)
                OR (status = 'leased' AND lease_expires_at <= ?)
             LIMIT 1`,
          )
          .get(input.now, input.now),
      ),
    );
    if (!hasClaimableWork) return [];
    return retrySqliteLockContention(() =>
      runSqliteWriteTransaction(this.handle, () => {
        this.recoverExpiredWithinTransaction(input.now, 1_000);
        const rows = this.handle.client
          .prepare(
            `SELECT * FROM queue_jobs WHERE status = 'available' AND available_at <= ?
             ORDER BY priority DESC, created_at, message_id LIMIT ?`,
          )
          .all(input.now, input.limit) as QueueJobRow[];
        const claimed: ClaimedJob[] = [];
        for (const row of rows) {
          const updated = this.handle.client
            .prepare(
              `UPDATE queue_jobs SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
               delivery_attempts = delivery_attempts + 1, updated_at = ?
               WHERE message_id = ? AND status = 'available'`,
            )
            .run(input.workerId, input.leaseExpiresAt, input.now, row.message_id);
          if (updated.changes !== 1) continue;
          claimed.push({
            job: mapJob(row),
            deliveryId: row.message_id,
            leaseExpiresAt: input.leaseExpiresAt,
            deliveryAttempt: row.delivery_attempts + 1,
          });
        }
        return claimed;
      }),
    );
  }

  async renew(input: {
    workerId: string;
    deliveryId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean> {
    return retrySqliteLockContention(() => {
      const result = this.handle.client
        .prepare(
          `UPDATE queue_jobs SET lease_expires_at = ?, updated_at = ?
           WHERE message_id = ? AND status = 'leased' AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(input.leaseExpiresAt, input.now, input.deliveryId, input.workerId, input.now);
      return result.changes === 1;
    });
  }

  async acknowledge(input: {
    workerId: string;
    deliveryId: string;
    acknowledgedAt: string;
  }): Promise<void> {
    await retrySqliteLockContention(() =>
      runSqliteWriteTransaction(this.handle, () => {
        const existing = this.required(input.deliveryId);
        if (existing.status === "completed") return;
        if (existing.status !== "leased" || existing.lease_owner !== input.workerId) {
          throw new Error("Job delivery is not owned by this worker.");
        }
        this.handle.client
          .prepare(
            `UPDATE queue_jobs SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
             completed_at = ?, updated_at = ? WHERE message_id = ?`,
          )
          .run(input.acknowledgedAt, input.acknowledgedAt, input.deliveryId);
      }),
    );
  }

  async reject(input: {
    workerId: string;
    deliveryId: string;
    errorCode: string;
    errorSummary: string;
    retryAt?: string;
    rejectedAt: string;
  }): Promise<"retrying" | "dead_letter"> {
    if (input.errorSummary.length > 2_048) throw new Error("Job error summary is too large.");
    return retrySqliteLockContention(() =>
      runSqliteWriteTransaction(this.handle, () => {
        const existing = this.required(input.deliveryId);
        if (existing.status !== "leased" || existing.lease_owner !== input.workerId) {
          throw new Error("Job delivery is not owned by this worker.");
        }
        const deadLetter = existing.delivery_attempts >= existing.maximum_deliveries;
        this.handle.client
          .prepare(
            `UPDATE queue_jobs SET status = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error_code = ?, last_error_summary = ?, updated_at = ?
             WHERE message_id = ?`,
          )
          .run(
            deadLetter ? "dead_letter" : "available",
            input.retryAt ?? input.rejectedAt,
            input.errorCode,
            input.errorSummary,
            input.rejectedAt,
            input.deliveryId,
          );
        return deadLetter ? "dead_letter" : "retrying";
      }),
    );
  }

  async recoverExpired(now: string, limit: number): Promise<number> {
    return retrySqliteLockContention(() =>
      runSqliteWriteTransaction(this.handle, () =>
        this.recoverExpiredWithinTransaction(now, limit),
      ),
    );
  }

  async listDeadLetters(limit: number): Promise<DeadLetterJob[]> {
    validateAdministrativeLimit(limit);
    return retrySqliteLockContention(() => {
      const rows = this.handle.client
        .prepare(
          `SELECT * FROM queue_jobs WHERE status = 'dead_letter'
           ORDER BY updated_at DESC, message_id LIMIT ?`,
        )
        .all(limit) as QueueJobRow[];
      return rows.map((row) => ({
        messageId: row.message_id,
        runId: row.run_id,
        kind: row.kind,
        deliveryAttempts: row.delivery_attempts,
        errorCode: row.last_error_code ?? "UNKNOWN",
        errorSummary: row.last_error_summary ?? "任务超过最大投递次数。",
        failedAt: row.updated_at,
      }));
    });
  }

  async redriveDeadLetters(input: { redrivenAt: string; limit: number }): Promise<number> {
    validateAdministrativeLimit(input.limit);
    return retrySqliteLockContention(() =>
      runSqliteWriteTransaction(this.handle, () => {
        const rows = this.handle.client
          .prepare(
            `SELECT message_id FROM queue_jobs WHERE status = 'dead_letter'
             ORDER BY updated_at, message_id LIMIT ?`,
          )
          .all(input.limit) as Array<{ message_id: string }>;
        let redriven = 0;
        for (const row of rows) {
          const result = this.handle.client
            .prepare(
              `UPDATE queue_jobs
               SET status = 'available', available_at = ?, lease_owner = NULL,
                   lease_expires_at = NULL, delivery_attempts = 0,
                   last_error_code = NULL, last_error_summary = NULL, updated_at = ?
               WHERE message_id = ? AND status = 'dead_letter'`,
            )
            .run(input.redrivenAt, input.redrivenAt, row.message_id);
          redriven += result.changes;
        }
        return redriven;
      }),
    );
  }

  async depth(): Promise<{ available: number; leased: number; deadLetter: number }> {
    return retrySqliteLockContention(() => {
      const rows = this.handle.client
        .prepare("SELECT status, COUNT(*) AS value FROM queue_jobs GROUP BY status")
        .all() as Array<{ status: QueueJobRow["status"]; value: number }>;
      const counts = new Map(rows.map((row) => [row.status, row.value]));
      return {
        available: counts.get("available") ?? 0,
        leased: counts.get("leased") ?? 0,
        deadLetter: counts.get("dead_letter") ?? 0,
      };
    });
  }

  async ready(): Promise<void> {
    await retrySqliteLockContention(() => {
      this.handle.client.prepare("SELECT 1 FROM queue_jobs LIMIT 1").get();
    });
  }

  async close(): Promise<void> {}

  private recoverExpiredWithinTransaction(now: string, limit: number): number {
    const rows = this.handle.client
      .prepare(
        `SELECT message_id, delivery_attempts, maximum_deliveries FROM queue_jobs
         WHERE status = 'leased' AND lease_expires_at <= ? ORDER BY lease_expires_at LIMIT ?`,
      )
      .all(now, limit) as Array<{
      message_id: string;
      delivery_attempts: number;
      maximum_deliveries: number;
    }>;
    for (const row of rows) {
      this.handle.client
        .prepare(
          `UPDATE queue_jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
           available_at = ?, last_error_code = 'LEASE_EXPIRED',
           last_error_summary = 'Worker lease expired before acknowledgement.', updated_at = ?
           WHERE message_id = ? AND status = 'leased'`,
        )
        .run(
          row.delivery_attempts >= row.maximum_deliveries ? "dead_letter" : "available",
          now,
          now,
          row.message_id,
        );
    }
    return rows.length;
  }

  private required(messageId: string): QueueJobRow {
    const row = this.handle.client
      .prepare("SELECT * FROM queue_jobs WHERE message_id = ?")
      .get(messageId) as QueueJobRow | undefined;
    if (!row) throw new Error("Job delivery does not exist.");
    return row;
  }
}

function mapJob(row: QueueJobRow): JobEnvelope {
  return jobEnvelopeSchema.parse({
    schemaVersion: row.schema_version,
    messageId: row.message_id,
    runId: row.run_id,
    attempt: row.attempt,
    createdAt: row.created_at,
    priority: row.priority,
    deduplicationKey: row.deduplication_key,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
  });
}

function validateClaim(input: {
  workerId: string;
  now: string;
  leaseExpiresAt: string;
  limit: number;
}) {
  if (!input.workerId || input.workerId.length > 128)
    throw new Error("Worker identity is invalid.");
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 256) {
    throw new Error("Job claim limit must be between 1 and 256.");
  }
  if (input.leaseExpiresAt <= input.now) throw new Error("Job lease expiry must be in the future.");
}

function validateAdministrativeLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Dead-letter operation limit must be between 1 and 100.");
  }
}
