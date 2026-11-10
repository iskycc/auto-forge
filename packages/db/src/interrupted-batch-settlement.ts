import { recoverableRoundTailSql } from "./round-dispatch-probe";

/** Repair interrupted lifecycle writes without depending on another Runner request. */
export function interruptedBatchSettlementSql(
  dialect: "sqlite" | "postgres",
  scope: "terminating_batches" | "batch_lifecycle" = "batch_lifecycle",
): string {
  const now = dialect === "postgres" ? "$1" : "?";
  const limit = dialect === "postgres" ? "$2" : "?";
  const terminating = `b.cancel_requested_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM assignments a
        JOIN assignment_leases l ON l.assignment_id=a.id
        JOIN run_attempts ra ON ra.id=a.attempt_id
        JOIN execution_runs r ON r.id=a.execution_run_id
        WHERE a.batch_id=b.id AND a.status IN ('claimed','running')
          AND l.status='active' AND l.expires_at>${now}
          AND ra.status IN ('assigned','running') AND r.status IN ('assigned','running')
      )`;
  // A partial execution snapshot must not be mistaken for a completed task.
  const finalized = `b.cancel_requested_at IS NULL AND b.total_runs>0
      AND NOT EXISTS(SELECT 1 FROM execution_runs r WHERE r.batch_id=b.id
        AND r.status IN ('queued','assigned','running'))
      AND (SELECT COUNT(*) FROM execution_runs r WHERE r.batch_id=b.id)=b.total_runs`;
  const roundTail = `b.cancel_requested_at IS NULL AND b.pause_requested_at IS NULL
    AND ${recoverableRoundTailSql(dialect, "b")}`;
  const eligible =
    scope === "terminating_batches"
      ? terminating
      : `((${terminating}) OR (${finalized}) OR (${roundTail}))`;
  return `SELECT b.id,b.cancel_requested_at AS termination_requested_at FROM run_batches b
    WHERE b.status IN ('queued','dispatching','scheduled','running') AND (${eligible})
    ORDER BY b.updated_at,b.id LIMIT ${limit}${dialect === "postgres" ? " FOR UPDATE OF b SKIP LOCKED" : ""}`;
}
