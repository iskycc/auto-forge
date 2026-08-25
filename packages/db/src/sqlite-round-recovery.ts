import type { RoundRecoveryClaim, RoundRecoveryRepository } from "@autoforge/application";
import type { RunBatchStatus } from "@autoforge/domain";

import { runSqliteWriteTransaction, type SqliteDatabaseHandle } from "./database";

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
  source_build_number: number | null;
  rebuild_number: number | null;
  rebuild_url: string | null;
};

export class SqliteRoundRecoveryRepository implements RoundRecoveryRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async claimDue(
    input: Parameters<RoundRecoveryRepository["claimDue"]>[0],
  ): Promise<RoundRecoveryClaim[]> {
    // 空闲轮询只读，避免每 5 秒用无效 BEGIN IMMEDIATE 与 Lite 工作器争抢单写者。
    if (input.limit <= 0 || this.dueRows(input.now, 1).length === 0) return [];
    return runSqliteWriteTransaction(this.handle, () => {
      const rows = this.dueRows(input.now, input.limit);
      const claims: RoundRecoveryClaim[] = [];
      for (const row of rows) {
        const claimed = this.handle.client
          .prepare(
            `UPDATE run_batch_round_recoveries
             SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
             WHERE batch_id = ? AND rule_id = ?
               AND status IN ('pending','polling','waiting','releasing')
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
          )
          .run(
            input.workerId,
            input.leaseExpiresAt,
            input.now,
            row.batch_id,
            row.rule_id,
            input.now,
          );
        if (claimed.changes === 1) claims.push(toClaim(row));
      }
      return claims;
    });
  }

  private dueRows(now: string, limit: number): RecoveryRow[] {
    return this.handle.client
      .prepare(
        `SELECT recovery.*, batch.suite_id
         FROM run_batch_round_recoveries recovery
         JOIN run_batches batch ON batch.id = recovery.batch_id
         WHERE recovery.status IN ('pending','polling','waiting','releasing')
           AND recovery.available_at <= ?
           AND (recovery.lease_expires_at IS NULL OR recovery.lease_expires_at <= ?)
           AND batch.status IN ('queued','dispatching','scheduled','running')
           AND batch.cancel_requested_at IS NULL
         ORDER BY recovery.available_at, recovery.batch_id, recovery.after_round
         LIMIT ?`,
      )
      .all(now, now, limit) as RecoveryRow[];
  }

  async markPolling(
    input: Parameters<RoundRecoveryRepository["markPolling"]>[0],
  ): Promise<boolean> {
    const result = this.handle.client
      .prepare(
        `UPDATE run_batch_round_recoveries
         SET status = 'polling', source_build_number = ?,
             rebuild_number = COALESCE(?, rebuild_number),
             rebuild_url = COALESCE(?, rebuild_url),
             started_at = COALESCE(?, started_at), available_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE batch_id = ? AND rule_id = ? AND lease_owner = ?
           AND status IN ('pending','polling')`,
      )
      .run(
        input.sourceBuildNumber,
        input.rebuildNumber ?? null,
        input.rebuildUrl ?? null,
        input.startedAt ?? null,
        input.availableAt,
        input.updatedAt,
        input.batchId,
        input.ruleId,
        input.workerId,
      );
    return result.changes === 1;
  }

  async markWaiting(
    input: Parameters<RoundRecoveryRepository["markWaiting"]>[0],
  ): Promise<boolean> {
    const result = this.handle.client
      .prepare(
        `UPDATE run_batch_round_recoveries
         SET status = 'waiting', rebuild_number = ?, rebuild_url = ?,
             started_at = COALESCE(?, started_at), finished_at = ?, build_result = ?,
             available_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE batch_id = ? AND rule_id = ? AND lease_owner = ? AND status = 'polling'`,
      )
      .run(
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
      );
    return result.changes === 1;
  }

  async completeWaitingStep(
    input: Parameters<RoundRecoveryRepository["completeWaitingStep"]>[0],
  ): ReturnType<RoundRecoveryRepository["completeWaitingStep"]> {
    return runSqliteWriteTransaction(this.handle, () => {
      const updated = this.handle.client
        .prepare(
          `UPDATE run_batch_round_recoveries
           SET status = 'succeeded', updated_at = ?
           WHERE batch_id = ? AND rule_id = ? AND lease_owner = ? AND status = 'waiting'`,
        )
        .run(input.updatedAt, input.batchId, input.ruleId, input.workerId);
      if (updated.changes !== 1) return { outcome: "claim_lost" };
      const recovery = this.handle.client
        .prepare(
          `SELECT after_round, next_round FROM run_batch_round_recoveries
           WHERE batch_id = ? AND rule_id = ?`,
        )
        .get(input.batchId, input.ruleId) as { after_round: number; next_round: number };
      const barrier = this.handle.client
        .prepare(
          `SELECT COUNT(*) AS remaining_steps FROM run_batch_round_recoveries
           WHERE batch_id = ? AND after_round = ? AND status <> 'succeeded'`,
        )
        .get(input.batchId, recovery.after_round) as { remaining_steps: number };
      if (barrier.remaining_steps > 0) {
        this.handle.client
          .prepare(
            `UPDATE run_batch_round_recoveries
             SET lease_owner = NULL, lease_expires_at = NULL
             WHERE batch_id = ? AND rule_id = ? AND lease_owner = ? AND status = 'succeeded'`,
          )
          .run(input.batchId, input.ruleId, input.workerId);
        return { outcome: "step_completed", remainingSteps: barrier.remaining_steps };
      }
      this.handle.client
        .prepare(
          `UPDATE run_batch_round_recoveries SET status = 'releasing'
           WHERE batch_id = ? AND rule_id = ? AND lease_owner = ? AND status = 'succeeded'`,
        )
        .run(input.batchId, input.ruleId, input.workerId);
      this.handle.client
        .prepare(
          `UPDATE execution_runs SET held_round = 0, updated_at = ?
           WHERE batch_id = ? AND status = 'queued' AND held_round <= ?`,
        )
        .run(input.updatedAt, input.batchId, recovery.next_round);
      this.handle.client
        .prepare("UPDATE run_batches SET current_round = ?, updated_at = ? WHERE id = ?")
        .run(recovery.next_round, input.updatedAt, input.batchId);
      return { outcome: "round_releasing" };
    });
  }

  async completeRoundRelease(
    input: Parameters<RoundRecoveryRepository["completeRoundRelease"]>[0],
  ): Promise<boolean> {
    const result = this.handle.client
      .prepare(
        `UPDATE run_batch_round_recoveries
         SET status = 'succeeded', error_message = NULL, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE batch_id = ? AND rule_id = ? AND lease_owner = ? AND status = 'releasing'`,
      )
      .run(input.updatedAt, input.batchId, input.ruleId, input.workerId);
    return result.changes === 1;
  }

  async retryRoundRelease(
    input: Parameters<RoundRecoveryRepository["retryRoundRelease"]>[0],
  ): Promise<boolean> {
    const result = this.handle.client
      .prepare(
        `UPDATE run_batch_round_recoveries
         SET error_message = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE batch_id = ? AND rule_id = ? AND lease_owner = ? AND status = 'releasing'`,
      )
      .run(
        input.errorMessage,
        input.availableAt,
        input.updatedAt,
        input.batchId,
        input.ruleId,
        input.workerId,
      );
    return result.changes === 1;
  }

  async fail(input: Parameters<RoundRecoveryRepository["fail"]>[0]): Promise<boolean> {
    return runSqliteWriteTransaction(this.handle, () => {
      const recovery = this.handle.client
        .prepare(
          `UPDATE run_batch_round_recoveries
           SET status = 'failed', error_message = ?,
               rebuild_number = COALESCE(?, rebuild_number),
               rebuild_url = COALESCE(?, rebuild_url),
               started_at = COALESCE(?, started_at),
               finished_at = COALESCE(?, finished_at),
               build_result = COALESCE(?, build_result), lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE batch_id = ? AND rule_id = ? AND lease_owner = ?
             AND status IN ('pending','polling','waiting')`,
        )
        .run(
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
        );
      if (recovery.changes !== 1) return false;
      this.handle.client
        .prepare(
          `UPDATE execution_runs
           SET status = 'failed', terminal_outcome = 'failed',
               terminal_reason_code = 'JENKINS_ROUND_RECOVERY_FAILED',
               held_round = 0, updated_at = ?
           WHERE batch_id = ? AND status = 'queued' AND held_round > 0`,
        )
        .run(input.updatedAt, input.batchId);
      const batch = this.handle.client
        .prepare("SELECT status, version FROM run_batches WHERE id = ?")
        .get(input.batchId) as { status: RunBatchStatus; version: number };
      if (
        batch.status !== "failed" &&
        batch.status !== "cancelled" &&
        batch.status !== "succeeded"
      ) {
        this.handle.client
          .prepare(
            `UPDATE run_batches SET status = 'failed', version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(input.updatedAt, input.batchId, batch.version);
        this.handle.client
          .prepare(
            `INSERT INTO run_batch_status_events
             (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
             VALUES (?, ?, ?, 'failed', ?, 'jenkins.round_recovery.failed', ?)`,
          )
          .run(input.eventId, input.batchId, batch.status, batch.version + 1, input.updatedAt);
      }
      return true;
    });
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
    ...(row.source_build_number === null ? {} : { sourceBuildNumber: row.source_build_number }),
    ...(row.rebuild_number === null ? {} : { rebuildNumber: row.rebuild_number }),
    ...(row.rebuild_url === null ? {} : { rebuildUrl: row.rebuild_url }),
  };
}
