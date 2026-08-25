import type { RoundRecoveryClaim, RoundRecoveryRepository } from "@autoforge/application";
import type { RunBatchStatus } from "@autoforge/domain";
import type { PoolClient } from "pg";

import { queueDeadlineAfter } from "./execution-queue-timing";
import type { PostgresDatabaseHandle } from "./postgres-database";

type RecoveryRow = {
  batch_id: string;
  suite_id: string;
  rule_id: string;
  after_round: number;
  next_round: number;
  jenkins_job_url: string;
  api_key_ciphertext: string;
  wait_minutes: number;
  status: "pending" | "polling" | "waiting" | "releasing";
  poll_failure_count: number;
  source_build_number: number | null;
  rebuild_number: number | null;
  rebuild_url: string | null;
};

export class PostgresRoundRecoveryRepository implements RoundRecoveryRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async claimDue(
    input: Parameters<RoundRecoveryRepository["claimDue"]>[0],
  ): Promise<RoundRecoveryClaim[]> {
    await this.handle.ready;
    return withTransaction(this.handle, async (client) => {
      const result = await client.query<RecoveryRow>(
        `SELECT recovery.*, batch.suite_id
         FROM run_batch_round_recoveries recovery
         JOIN run_batches batch ON batch.id = recovery.batch_id
         WHERE recovery.status IN ('pending','polling','waiting','releasing')
           AND recovery.available_at <= $1
           AND (recovery.lease_expires_at IS NULL OR recovery.lease_expires_at <= $1)
           AND batch.status IN ('queued','dispatching','scheduled','running')
           AND batch.cancel_requested_at IS NULL
         ORDER BY recovery.available_at, recovery.batch_id, recovery.after_round
         LIMIT $2 FOR UPDATE OF recovery SKIP LOCKED`,
        [input.now, input.limit],
      );
      const claims: RoundRecoveryClaim[] = [];
      for (const row of result.rows) {
        const updated = await client.query(
          `UPDATE run_batch_round_recoveries
           SET lease_owner = $1, lease_expires_at = $2, updated_at = $3
           WHERE batch_id = $4 AND rule_id = $5
             AND status IN ('pending','polling','waiting','releasing')
             AND (lease_expires_at IS NULL OR lease_expires_at <= $3)`,
          [input.workerId, input.leaseExpiresAt, input.now, row.batch_id, row.rule_id],
        );
        if (updated.rowCount === 1) claims.push(toClaim(row));
      }
      return claims;
    });
  }

  async markPolling(
    input: Parameters<RoundRecoveryRepository["markPolling"]>[0],
  ): Promise<boolean> {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `UPDATE run_batch_round_recoveries
       SET status = 'polling', source_build_number = $1,
           rebuild_number = COALESCE($2, rebuild_number),
           rebuild_url = COALESCE($3, rebuild_url),
           started_at = COALESCE($4, started_at), available_at = $5,
           poll_failure_count = 0, error_message = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = $6
       WHERE batch_id = $7 AND rule_id = $8 AND lease_owner = $9
         AND status IN ('pending','polling')`,
      [
        input.sourceBuildNumber,
        input.rebuildNumber ?? null,
        input.rebuildUrl ?? null,
        input.startedAt ?? null,
        input.availableAt,
        input.updatedAt,
        input.batchId,
        input.ruleId,
        input.workerId,
      ],
    );
    return result.rowCount === 1;
  }

  async markWaiting(
    input: Parameters<RoundRecoveryRepository["markWaiting"]>[0],
  ): Promise<boolean> {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `UPDATE run_batch_round_recoveries
       SET status = 'waiting', rebuild_number = $1, rebuild_url = $2,
           started_at = COALESCE($3, started_at), finished_at = $4, build_result = $5,
           available_at = $6, poll_failure_count = 0, error_message = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = $7
       WHERE batch_id = $8 AND rule_id = $9 AND lease_owner = $10 AND status = 'polling'`,
      [
        input.rebuildNumber,
        input.rebuildUrl,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        input.buildResult,
        input.availableAt,
        input.updatedAt,
        input.batchId,
        input.ruleId,
        input.workerId,
      ],
    );
    return result.rowCount === 1;
  }

  async completeWaitingStep(
    input: Parameters<RoundRecoveryRepository["completeWaitingStep"]>[0],
  ): ReturnType<RoundRecoveryRepository["completeWaitingStep"]> {
    await this.handle.ready;
    return withTransaction(this.handle, async (client) => {
      // 同轮步骤可以在不同 Web/Worker 实例上同时到期。锁定批次可避免两个
      // 最后步骤互相看不到未提交结果，导致全部 succeeded 却无人释放下一轮。
      const batch = await client.query<{ queue_timeout_ms: number }>(
        "SELECT queue_timeout_ms FROM run_batches WHERE id = $1 FOR UPDATE",
        [input.batchId],
      );
      const queueTimeoutMs = batch.rows[0]?.queue_timeout_ms;
      if (queueTimeoutMs === undefined) return { outcome: "claim_lost" };
      const updated = await client.query<{ after_round: number; next_round: number }>(
        `UPDATE run_batch_round_recoveries
         SET status = 'succeeded', updated_at = $1
         WHERE batch_id = $2 AND rule_id = $3 AND lease_owner = $4 AND status = 'waiting'
         RETURNING after_round, next_round`,
        [input.updatedAt, input.batchId, input.ruleId, input.workerId],
      );
      const recovery = updated.rows[0];
      if (!recovery) return { outcome: "claim_lost" };
      const barrier = await client.query<{ remaining_steps: string }>(
        `SELECT COUNT(*) AS remaining_steps FROM run_batch_round_recoveries
         WHERE batch_id = $1 AND after_round = $2 AND status <> 'succeeded'`,
        [input.batchId, recovery.after_round],
      );
      const remainingSteps = Number(barrier.rows[0]?.remaining_steps ?? 0);
      if (remainingSteps > 0) {
        await client.query(
          `UPDATE run_batch_round_recoveries
           SET lease_owner = NULL, lease_expires_at = NULL
           WHERE batch_id = $1 AND rule_id = $2 AND lease_owner = $3 AND status = 'succeeded'`,
          [input.batchId, input.ruleId, input.workerId],
        );
        return { outcome: "step_completed", remainingSteps };
      }
      await client.query(
        `UPDATE run_batch_round_recoveries SET status = 'releasing'
         WHERE batch_id = $1 AND rule_id = $2 AND lease_owner = $3 AND status = 'succeeded'`,
        [input.batchId, input.ruleId, input.workerId],
      );
      await client.query(
        `UPDATE execution_runs SET held_round = 0, queue_deadline_at = $1, updated_at = $2
         WHERE batch_id = $3 AND status = 'queued' AND held_round <= $4`,
        [
          queueDeadlineAfter(input.updatedAt, queueTimeoutMs),
          input.updatedAt,
          input.batchId,
          recovery.next_round,
        ],
      );
      await client.query(
        "UPDATE run_batches SET current_round = $1, updated_at = $2 WHERE id = $3",
        [recovery.next_round, input.updatedAt, input.batchId],
      );
      return { outcome: "round_releasing" };
    });
  }

  async completeRoundRelease(
    input: Parameters<RoundRecoveryRepository["completeRoundRelease"]>[0],
  ): Promise<boolean> {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `UPDATE run_batch_round_recoveries
       SET status = 'succeeded', error_message = NULL, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = $1
       WHERE batch_id = $2 AND rule_id = $3 AND lease_owner = $4 AND status = 'releasing'`,
      [input.updatedAt, input.batchId, input.ruleId, input.workerId],
    );
    return result.rowCount === 1;
  }

  async retryRoundRelease(
    input: Parameters<RoundRecoveryRepository["retryRoundRelease"]>[0],
  ): Promise<boolean> {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `UPDATE run_batch_round_recoveries
       SET error_message = $1, available_at = $2, lease_owner = NULL,
           lease_expires_at = NULL, updated_at = $3
       WHERE batch_id = $4 AND rule_id = $5 AND lease_owner = $6 AND status = 'releasing'`,
      [
        input.errorMessage,
        input.availableAt,
        input.updatedAt,
        input.batchId,
        input.ruleId,
        input.workerId,
      ],
    );
    return result.rowCount === 1;
  }

  async deferPollingFailure(
    input: Parameters<RoundRecoveryRepository["deferPollingFailure"]>[0],
  ): Promise<boolean> {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `UPDATE run_batch_round_recoveries
       SET poll_failure_count = poll_failure_count + 1, error_message = $1, available_at = $2,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = $3
       WHERE batch_id = $4 AND rule_id = $5 AND lease_owner = $6 AND status = 'polling'`,
      [
        input.errorMessage,
        input.availableAt,
        input.updatedAt,
        input.batchId,
        input.ruleId,
        input.workerId,
      ],
    );
    return result.rowCount === 1;
  }

  async fail(input: Parameters<RoundRecoveryRepository["fail"]>[0]): Promise<boolean> {
    await this.handle.ready;
    return withTransaction(this.handle, async (client) => {
      const recovery = await client.query(
        `UPDATE run_batch_round_recoveries
         SET status = 'failed', error_message = $1,
             rebuild_number = COALESCE($2, rebuild_number),
             rebuild_url = COALESCE($3, rebuild_url),
             started_at = COALESCE($4, started_at),
             finished_at = COALESCE($5, finished_at),
             build_result = COALESCE($6, build_result), lease_owner = NULL,
             lease_expires_at = NULL, updated_at = $7
         WHERE batch_id = $8 AND rule_id = $9 AND lease_owner = $10
           AND status IN ('pending','polling','waiting')`,
        [
          input.errorMessage,
          input.rebuildNumber ?? null,
          input.rebuildUrl ?? null,
          input.startedAt ?? null,
          input.finishedAt ?? null,
          input.buildResult ?? null,
          input.updatedAt,
          input.batchId,
          input.ruleId,
          input.workerId,
        ],
      );
      if (recovery.rowCount !== 1) return false;
      await client.query(
        `UPDATE execution_runs
         SET status = 'failed', terminal_outcome = 'failed',
             terminal_reason_code = 'JENKINS_ROUND_RECOVERY_FAILED',
             held_round = 0, updated_at = $1
         WHERE batch_id = $2 AND status = 'queued' AND held_round > 0`,
        [input.updatedAt, input.batchId],
      );
      const locked = await client.query<{ status: RunBatchStatus; version: number }>(
        "SELECT status, version FROM run_batches WHERE id = $1 FOR UPDATE",
        [input.batchId],
      );
      const batch = locked.rows[0];
      if (
        batch &&
        batch.status !== "failed" &&
        batch.status !== "cancelled" &&
        batch.status !== "succeeded"
      ) {
        await client.query(
          `UPDATE run_batches SET status = 'failed', version = version + 1, updated_at = $1
           WHERE id = $2 AND version = $3`,
          [input.updatedAt, input.batchId, batch.version],
        );
        await client.query(
          `INSERT INTO run_batch_status_events
           (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
           VALUES ($1, $2, $3, 'failed', $4, 'jenkins.round_recovery.failed', $5)`,
          [input.eventId, input.batchId, batch.status, batch.version + 1, input.updatedAt],
        );
      }
      return true;
    });
  }
}

async function withTransaction<T>(
  handle: PostgresDatabaseHandle,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function toClaim(row: RecoveryRow): RoundRecoveryClaim {
  return {
    batchId: row.batch_id,
    suiteId: row.suite_id,
    ruleId: row.rule_id,
    afterRound: row.after_round,
    nextRound: row.next_round,
    jenkinsJobUrl: row.jenkins_job_url,
    apiKeyCiphertext: row.api_key_ciphertext,
    waitMinutes: row.wait_minutes,
    status: row.status,
    pollFailureCount: row.poll_failure_count,
    ...(row.source_build_number === null ? {} : { sourceBuildNumber: row.source_build_number }),
    ...(row.rebuild_number === null ? {} : { rebuildNumber: row.rebuild_number }),
    ...(row.rebuild_url === null ? {} : { rebuildUrl: row.rebuild_url }),
  };
}
