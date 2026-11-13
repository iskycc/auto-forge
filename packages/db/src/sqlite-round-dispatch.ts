import {
  finishHeldRetriesSql,
  retryRoundStatisticsSql,
  roundCompletionDecision,
  type RetryRoundStatistics,
} from "./retry-completion-query";
import { roundDispatchTarget, roundNeedsCompleteStatistics } from "@autoforge/domain";
import type { SqliteDatabaseHandle } from "./database";
import { queueDeadlineAfter } from "./execution-queue-timing";

/** Caller owns the short write transaction; pause/cancel and the round window are rechecked. */
export function advanceSqliteSchedulingRound(
  handle: SqliteDatabaseHandle,
  batchId: string,
  now: string,
): void {
  const batch = handle.client
    .prepare(
      `SELECT current_round, queue_timeout_ms, policy_json
    FROM run_batches WHERE id=? AND retry_mode='round' AND status IN ('queued','dispatching','scheduled','running')
    AND pause_requested_at IS NULL AND cancel_requested_at IS NULL`,
    )
    .get(batchId) as
    { current_round: number; queue_timeout_ms: number; policy_json: string } | undefined;
  if (!batch) return;
  const state = handle.client
    .prepare(
      `SELECT
    (SELECT MIN(held_round) FROM execution_runs WHERE batch_id=? AND status='queued' AND held_round>0) AS held,
    (SELECT MIN(execution_round) FROM execution_runs WHERE batch_id=? AND status IN ('assigned','running')) AS active,
    EXISTS(SELECT 1 FROM execution_runs WHERE batch_id=? AND status='queued' AND held_round=0) AS queued`,
    )
    .get(batchId, batchId, batchId) as {
    held: number | null;
    active: number | null;
    queued: number;
  };
  if (state.held === null) return;
  const policy = JSON.parse(batch.policy_json ?? "{}") as {
    retryStopRules?: { afterRound: number }[];
  };
  if (
    state.held > batch.current_round &&
    !state.queued &&
    state.active === null &&
    policy.retryStopRules?.some((rule) => rule.afterRound === batch.current_round)
  ) {
    const statistics = handle.client
      .prepare(retryRoundStatisticsSql("?1", "?2"))
      .get({ 1: batchId, 2: batch.current_round }) as RetryRoundStatistics;
    const completion = roundCompletionDecision(batch.policy_json, batch.current_round, statistics);
    if (completion) {
      handle.client.prepare(finishHeldRetriesSql("?1", "?2")).run({ 1: batchId, 2: now });
      handle.client
        .prepare("UPDATE run_batches SET policy_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify({ ...policy, retryCompletion: completion }), now, batchId);
      handle.client
        .prepare(
          "UPDATE run_batch_round_recoveries SET status='cancelled', updated_at=? WHERE batch_id=? AND status='idle'",
        )
        .run(now, batchId);
      return;
    }
  }

  const recovery = handle.client
    .prepare(
      `SELECT COUNT(*) AS total,
    SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded
    FROM run_batch_round_recoveries WHERE batch_id=? AND after_round=?`,
    )
    .get(batchId, state.held - 1) as { total: number; succeeded: number | null };
  const target = roundDispatchTarget({
    currentRound: batch.current_round,
    nextHeldRound: state.held,
    oldestActiveRound: state.active,
    hasQueuedWork: Boolean(state.queued),
    requiresCompletedRound:
      recovery.total > 0 || roundNeedsCompleteStatistics(batch.policy_json, state.held),
  });
  if (target === null) return;
  if (target > batch.current_round && recovery.total > 0) {
    handle.client
      .prepare(
        `UPDATE run_batch_round_recoveries SET status='pending', available_at=?,
      activated_at=COALESCE(activated_at,?), updated_at=?
      WHERE batch_id=? AND after_round=? AND status='idle'`,
      )
      .run(now, now, now, batchId, target - 1);
    if ((recovery.succeeded ?? 0) < recovery.total) return;
  }
  handle.client
    .prepare(
      `UPDATE execution_runs SET held_round=0, queue_deadline_at=?, updated_at=?
    WHERE batch_id=? AND status='queued' AND held_round>0 AND held_round<=?`,
    )
    .run(queueDeadlineAfter(now, batch.queue_timeout_ms), now, batchId, target);
  if (target > batch.current_round) {
    handle.client
      .prepare("UPDATE run_batches SET current_round=?, updated_at=? WHERE id=?")
      .run(target, now, batchId);
  }
}
