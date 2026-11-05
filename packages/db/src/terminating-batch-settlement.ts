/** Valid leased work must drain; unclaimed retries and orphaned statuses cannot block termination. */
export function terminatingBatchSettlementSql(dialect: "sqlite" | "postgres"): string {
  const now = dialect === "postgres" ? "$1" : "?";
  const limit = dialect === "postgres" ? "$2" : "?";
  return `SELECT b.id FROM run_batches b
    WHERE b.status IN ('queued','dispatching','scheduled','running')
      AND b.cancel_requested_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM assignments a
        JOIN assignment_leases l ON l.assignment_id=a.id
        JOIN run_attempts ra ON ra.id=a.attempt_id
        JOIN execution_runs r ON r.id=a.execution_run_id
        WHERE a.batch_id=b.id AND a.status IN ('claimed','running')
          AND l.status='active' AND l.expires_at>${now}
          AND ra.status IN ('assigned','running') AND r.status IN ('assigned','running')
      )
    ORDER BY b.updated_at,b.id LIMIT ${limit}${dialect === "postgres" ? " FOR UPDATE OF b SKIP LOCKED" : ""}`;
}
