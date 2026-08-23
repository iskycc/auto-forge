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
  status: "pending" | "polling" | "waiting";
  source_build_number: number | null;
  rebuild_number: number | null;
  rebuild_url: string | null;
};

export class SqliteRoundRecoveryRepository implements RoundRecoveryRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async claimDue(
    input: Parameters<RoundRecoveryRepository["claimDue"]>[0],
  ): Promise<RoundRecoveryClaim[]> {
    return runSqliteWriteTransaction(this.handle, () => {
      const rows = this.handle.client
        .prepare(
          `SELECT recovery.*, batch.suite_id
           FROM run_batch_round_recoveries recovery
           JOIN run_batches batch ON batch.id = recovery.batch_id
           WHERE recovery.status IN ('pending','polling','waiting')
             AND recovery.available_at <= ?
             AND (recovery.lease_expires_at IS NULL OR recovery.lease_expires_at <= ?)
             AND batch.status IN ('queued','dispatching','scheduled','running')
             AND batch.cancel_requested_at IS NULL
           ORDER BY recovery.available_at, recovery.batch_id, recovery.after_round
           LIMIT ?`,
        )
        .all(input.now, input.now, input.limit) as RecoveryRow[];
      const claims: RoundRecoveryClaim[] = [];
      for (const row of rows) {
        const claimed = this.handle.client
          .prepare(
            `UPDATE run_batch_round_recoveries
             SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
             WHERE batch_id = ? AND rule_id = ?
               AND status IN ('pending','polling','waiting')
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

  async markPolling(
    input: Parameters<RoundRecoveryRepository["markPolling"]>[0],
  ): Promise<boolean> {
    const result = this.handle.client
      .prepare(
        `UPDATE run_batch_round_recoveries
         SET status = 'polling', source_build_number = ?,
             rebuild_number = COALESCE(?, rebuild_number),
             rebuild_url = COALESCE(?, rebuild_url), available_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE batch_id = ? AND rule_id = ? AND lease_owner = ?
           AND status IN ('pending','polling')`,
      )
      .run(
        input.sourceBuildNumber,
        input.rebuildNumber ?? null,
        input.rebuildUrl ?? null,
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
         SET status = 'waiting', available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE batch_id = ? AND rule_id = ? AND lease_owner = ? AND status = 'polling'`,
      )
      .run(input.availableAt, input.updatedAt, input.batchId, input.ruleId, input.workerId);
    return result.changes === 1;
  }

  async resume(input: Parameters<RoundRecoveryRepository["resume"]>[0]): Promise<boolean> {
    return runSqliteWriteTransaction(this.handle, () => {
      const updated = this.handle.client
        .prepare(
          `UPDATE run_batch_round_recoveries
           SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE batch_id = ? AND rule_id = ? AND lease_owner = ? AND status = 'waiting'`,
        )
        .run(input.updatedAt, input.batchId, input.ruleId, input.workerId);
      if (updated.changes !== 1) return false;
      const recovery = this.handle.client
        .prepare(
          `SELECT next_round FROM run_batch_round_recoveries
           WHERE batch_id = ? AND rule_id = ?`,
        )
        .get(input.batchId, input.ruleId) as { next_round: number };
      this.handle.client
        .prepare(
          `UPDATE execution_runs SET held_round = 0, updated_at = ?
           WHERE batch_id = ? AND status = 'queued' AND held_round <= ?`,
        )
        .run(input.updatedAt, input.batchId, recovery.next_round);
      this.handle.client
        .prepare("UPDATE run_batches SET current_round = ?, updated_at = ? WHERE id = ?")
        .run(recovery.next_round, input.updatedAt, input.batchId);
      return true;
    });
  }

  async fail(input: Parameters<RoundRecoveryRepository["fail"]>[0]): Promise<boolean> {
    return runSqliteWriteTransaction(this.handle, () => {
      const recovery = this.handle.client
        .prepare(
          `UPDATE run_batch_round_recoveries
           SET status = 'failed', error_message = ?, lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE batch_id = ? AND rule_id = ? AND lease_owner = ?
             AND status IN ('pending','polling','waiting')`,
        )
        .run(input.errorMessage, input.updatedAt, input.batchId, input.ruleId, input.workerId);
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
