/** The scan window must contain batches that can actually accept another assignment.
 * Otherwise a full earlier batch consumes the entire one-slot claim scan and starves later work.
 */
export function schedulableBatchCapacitySql(
  dialect: "sqlite" | "postgres",
  batch: "b" | "run_batches",
): string {
  const concurrencyField =
    dialect === "sqlite"
      ? `json_extract(${batch}.policy_json, '$.concurrency')`
      : `(${batch}.policy_json::jsonb ->> 'concurrency')::integer`;
  // A legacy NULL policy has no batch cap; an object without concurrency uses the reader's default.
  const configuredConcurrency = `CASE WHEN ${batch}.policy_json IS NULL THEN NULL ELSE COALESCE(${concurrencyField},4) END`;
  return `COALESCE(
    (SELECT state.concurrency FROM run_batch_retry_concurrency_states state WHERE state.batch_id=${batch}.id),
    ${configuredConcurrency}, ${Number.MAX_SAFE_INTEGER}
  ) > ${activeBatchRunsSql(batch)}`;
}

/** Waiting-time promotion prevents queued tasks from starving. Once work is in flight,
 * older start times must not let one task reclaim every slot ahead of its peers.
 */
export function schedulableBatchOrderSql(
  dialect: "sqlite" | "postgres",
  batch: "b" | "run_batches",
): string {
  const activeRuns = activeBatchRunsSql(batch);
  const nowParameter = batch === "b" ? "$2" : "$1";
  const agingParameter = batch === "b" ? "$3" : "$2";
  const waitingPromotion =
    dialect === "sqlite"
      ? `MIN(100, MAX(0, CAST((julianday(?) - julianday(${batch}.scheduled_for)) * 1440 / ? AS INTEGER)))`
      : `LEAST(100, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${nowParameter}::timestamptz-${batch}.scheduled_for::timestamptz)) / 60 / ${agingParameter})))`;
  return `${batch}.priority + CASE WHEN ${activeRuns} = 0 THEN ${waitingPromotion} ELSE 0 END DESC,
    ${activeRuns} ASC, ${batch}.scheduled_for, ${batch}.id`;
}

function activeBatchRunsSql(batch: "b" | "run_batches"): string {
  return `(
    SELECT count(*) FROM execution_runs active_run
    JOIN run_attempts active_attempt ON active_attempt.execution_run_id=active_run.id
    WHERE active_run.batch_id=${batch}.id
      AND active_run.status IN ('assigned','running')
      AND active_attempt.status IN ('assigned','running')
  )`;
}
