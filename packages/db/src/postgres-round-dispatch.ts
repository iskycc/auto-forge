import {
  finishHeldRetriesSql,
  retryRoundStatisticsSql,
  roundCompletionDecision,
  type RetryRoundStatistics,
} from "./retry-completion-query";
import { roundDispatchTarget, roundNeedsCompleteStatistics } from "@autoforge/domain";
import type { PoolClient } from "pg";
import { queueDeadlineAfter } from "./execution-queue-timing";

/** Serialize with completion, pause and cancellation on the authoritative batch row. */
export async function advancePostgresSchedulingRound(
  client: PoolClient,
  batchId: string,
  now: string,
): Promise<void> {
  const batch = (
    await client.query<{
      current_round: number;
      queue_timeout_ms: number;
      policy_json: string | null;
    }>(
      `SELECT current_round, queue_timeout_ms, policy_json FROM run_batches
    WHERE id=$1 AND retry_mode='round' AND status IN ('queued','dispatching','scheduled','running')
    AND pause_requested_at IS NULL AND cancel_requested_at IS NULL FOR UPDATE`,
      [batchId],
    )
  ).rows[0];
  if (!batch) return;
  const state = (
    await client.query<{ held: number | null; active: number | null; queued: boolean }>(
      `SELECT
    (SELECT MIN(held_round) FROM execution_runs WHERE batch_id=$1 AND status='queued' AND held_round>0) AS held,
    (SELECT MIN(execution_round) FROM execution_runs WHERE batch_id=$1 AND status IN ('assigned','running')) AS active,
    EXISTS(SELECT 1 FROM execution_runs WHERE batch_id=$1 AND status='queued' AND held_round=0) AS queued`,
      [batchId],
    )
  ).rows[0]!;
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
    const statistics = (
      await client.query<RetryRoundStatistics>(retryRoundStatisticsSql("$1", "$2"), [
        batchId,
        batch.current_round,
      ])
    ).rows[0]!;
    const completion = roundCompletionDecision(batch.policy_json, batch.current_round, statistics);
    if (completion) {
      await client.query(finishHeldRetriesSql("$1", "$2"), [batchId, now]);
      await client.query("UPDATE run_batches SET policy_json=$1, updated_at=$2 WHERE id=$3", [
        JSON.stringify({ ...policy, retryCompletion: completion }),
        now,
        batchId,
      ]);
      await client.query(
        "UPDATE run_batch_round_recoveries SET status='cancelled', updated_at=$1 WHERE batch_id=$2 AND status='idle'",
        [now, batchId],
      );
      return;
    }
  }

  const recovery = (
    await client.query<{ total: string; succeeded: string }>(
      `SELECT COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status='succeeded') AS succeeded FROM run_batch_round_recoveries
    WHERE batch_id=$1 AND after_round=$2`,
      [batchId, state.held - 1],
    )
  ).rows[0]!;
  const target = roundDispatchTarget({
    currentRound: batch.current_round,
    nextHeldRound: state.held,
    oldestActiveRound: state.active,
    hasQueuedWork: state.queued,
    requiresCompletedRound:
      Number(recovery.total) > 0 || roundNeedsCompleteStatistics(batch.policy_json, state.held),
  });
  if (target === null) return;
  if (target > batch.current_round && Number(recovery.total) > 0) {
    await client.query(
      `UPDATE run_batch_round_recoveries SET status='pending', available_at=$1,
      activated_at=COALESCE(activated_at,$1), updated_at=$1
      WHERE batch_id=$2 AND after_round=$3 AND status='idle'`,
      [now, batchId, target - 1],
    );
    if (Number(recovery.succeeded) < Number(recovery.total)) return;
  }
  await client.query(
    `UPDATE execution_runs SET held_round=0, queue_deadline_at=$1, updated_at=$2
    WHERE batch_id=$3 AND status='queued' AND held_round>0 AND held_round<=$4`,
    [queueDeadlineAfter(now, batch.queue_timeout_ms), now, batchId, target],
  );
  if (target > batch.current_round) {
    await client.query("UPDATE run_batches SET current_round=$1, updated_at=$2 WHERE id=$3", [
      target,
      now,
      batchId,
    ]);
  }
}
