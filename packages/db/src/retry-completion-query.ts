import {
  retryCompletionForRound,
  type RetryCompletion,
  type RunBatchExecutionPolicy,
} from "@autoforge/domain";

export type RetryRoundStatistics = {
  total: number | string;
  succeeded: number | string;
  round_total: number | string;
  round_succeeded: number | string;
};

export function roundCompletionDecision(
  policyJson: string | null,
  round: number,
  statistics: RetryRoundStatistics,
): RetryCompletion | undefined {
  const policy = JSON.parse(policyJson ?? "{}") as RunBatchExecutionPolicy;
  return retryCompletionForRound(policy.retryStopRules ?? [], {
    round,
    totalRuns: Number(statistics.total),
    succeededRuns: Number(statistics.succeeded),
    roundRuns: Number(statistics.round_total),
    roundSucceeded: Number(statistics.round_succeeded),
    remainingRuns: Number(statistics.total) - Number(statistics.succeeded),
  });
}

/** Only called once the configured boundary has drained, never for each completion. */
export function retryRoundStatisticsSql(batchParameter: string, roundParameter: string): string {
  return `SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN r.status='succeeded' THEN 1 ELSE 0 END),0) AS succeeded,
    COALESCE(SUM(CASE WHEN a.execution_round=${roundParameter} THEN 1 ELSE 0 END),0) AS round_total,
    COALESCE(SUM(CASE WHEN a.execution_round=${roundParameter} AND a.outcome='succeeded' THEN 1 ELSE 0 END),0) AS round_succeeded
    FROM execution_runs r LEFT JOIN run_attempts a ON a.execution_run_id=r.id AND a.attempt_number=r.attempt_count
    WHERE r.batch_id=${batchParameter}`;
}

/** Retain the last actual result and logical round; never manufacture another attempt. */
export function finishHeldRetriesSql(batchParameter: string, nowParameter: string): string {
  return `UPDATE execution_runs SET status='failed', held_round=0, queue_deadline_at=NULL,
    terminal_outcome=COALESCE((SELECT outcome FROM run_attempts a WHERE a.execution_run_id=execution_runs.id AND a.attempt_number=execution_runs.attempt_count),'failed'),
    terminal_reason_code=(SELECT result_code FROM run_attempts a WHERE a.execution_run_id=execution_runs.id AND a.attempt_number=execution_runs.attempt_count),
    execution_round=COALESCE((SELECT execution_round FROM run_attempts a WHERE a.execution_run_id=execution_runs.id AND a.attempt_number=execution_runs.attempt_count),execution_round),
    updated_at=${nowParameter}, version=version+1 WHERE batch_id=${batchParameter} AND status='queued' AND held_round>0`;
}
