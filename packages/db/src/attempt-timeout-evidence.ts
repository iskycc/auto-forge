import { describeExecutionTimeout } from "@autoforge/domain";

export type AttemptTimeoutEvidenceRow = {
  started_at: string | null;
  execution_timeout_ms: number;
  renewed_at: string | null;
  expires_at: string | null;
  last_seen_at: string | null;
};

/** All reads are indexed point lookups in the business database, never log-store I/O. */
export function attemptTimeoutEvidenceSql(parameter: "$1" | "?"): string {
  return `SELECT a.started_at,r.execution_timeout_ms,l.renewed_at,l.expires_at,n.last_seen_at
    FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id
    JOIN assignments s ON s.attempt_id=a.id
    LEFT JOIN runners n ON n.id=a.runner_id
    LEFT JOIN assignment_leases l ON l.id=(
      SELECT id FROM assignment_leases WHERE assignment_id=s.id ORDER BY created_at DESC LIMIT 1
    ) WHERE a.id=${parameter}`;
}

export function summarizeAttemptTimeout(
  evidence: AttemptTimeoutEvidenceRow,
  detectedAt: string,
): string {
  return describeExecutionTimeout({
    startedAt: evidence.started_at,
    detectedAt,
    timeoutMs: Number(evidence.execution_timeout_ms),
    leaseRenewedAt: evidence.renewed_at,
    leaseExpiresAt: evidence.expires_at,
    runnerLastSeenAt: evidence.last_seen_at,
  });
}
