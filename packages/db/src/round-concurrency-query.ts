type Dialect = "sqlite" | "postgres";
type BatchAlias = "b" | "run_batches";

function baseConcurrencySql(dialect: Dialect, batch: BatchAlias): string {
  const configured =
    dialect === "sqlite"
      ? `json_extract(${batch}.policy_json,'$.concurrency')`
      : `(${batch}.policy_json::jsonb->>'concurrency')::integer`;
  // Match the policy reader, including uncapped legacy NULL snapshots.
  return `CASE WHEN ${batch}.policy_json IS NULL THEN NULL ELSE COALESCE(${configured},4) END`;
}

/** Same-round infrastructure retries keep the older round open even between leases. */
export function overlappingRoundConcurrencySql(dialect: Dialect, batch: BatchAlias): string {
  return `(SELECT MIN(COALESCE(round_cap.concurrency,${baseConcurrencySql(dialect, batch)},${Number.MAX_SAFE_INTEGER}))
    FROM execution_runs older_run
    LEFT JOIN run_batch_round_concurrencies round_cap ON round_cap.batch_id=older_run.batch_id
      AND round_cap.execution_round=older_run.execution_round
    WHERE ${batch}.retry_mode='round' AND older_run.batch_id=${batch}.id
      AND older_run.status IN ('queued','assigned','running')
      AND (older_run.status<>'queued' OR older_run.held_round=0)
      AND older_run.execution_round<${batch}.current_round)`;
}

/** Shared by discovery, diagnostics and the transaction that reserves actual slots. */
export function batchConcurrencyLimitSql(dialect: Dialect, batch: BatchAlias): string {
  const current = `COALESCE(
    (SELECT state.concurrency FROM run_batch_retry_concurrency_states state WHERE state.batch_id=${batch}.id),
    ${baseConcurrencySql(dialect, batch)},${Number.MAX_SAFE_INTEGER})`;
  const minimum = dialect === "sqlite" ? "MIN" : "LEAST";
  return `${minimum}(${current},COALESCE(${overlappingRoundConcurrencySql(dialect, batch)},${Number.MAX_SAFE_INTEGER}))`;
}
