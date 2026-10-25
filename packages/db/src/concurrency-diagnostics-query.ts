import { sql } from "drizzle-orm";
import type { ConcurrencySnapshot, RunBatchMetadata } from "@autoforge/application";
import type { Runner } from "@autoforge/domain";
import { projectAdapterCapabilitiesForFeatures } from "./project-adapter-runtime";

export type ConcurrencyCountRow = {
  running: number | string;
  assigned: number | string;
  ready: number | string;
  held: number | string;
  adapterEnabled: number | boolean;
  runtimeAssets: number | boolean;
  ddt: number | boolean;
  ruleConcurrency: number | null;
  recoveryPending: number | boolean;
};
export type RunnerReservationRow = {
  runnerId: string;
  reserved: number | string;
  own: number | string;
};

/** Read only scalar runtime features: the environment-to-run JSON map can be very large. */
export function concurrencyCountsQuery(dialect: "sqlite" | "postgres", batchId: string) {
  const feature = (path: string) =>
    sql.raw(
      dialect === "sqlite"
        ? `json_type(b.adapter_runtime_json, '$.${path}') = 'object'`
        : `jsonb_typeof(b.adapter_runtime_json::jsonb -> '${path}') = 'object'`,
    );
  const ddt = sql.raw(
    dialect === "sqlite"
      ? `json_extract(b.adapter_runtime_json, '$.requiresDdtCaseId') = 1`
      : `(b.adapter_runtime_json::jsonb ->> 'requiresDdtCaseId') = 'true'`,
  );
  return sql`WITH pending AS (
    SELECT
      COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) AS running,
      COALESCE(SUM(CASE WHEN status='assigned' THEN 1 ELSE 0 END),0) AS assigned,
      COALESCE(SUM(CASE WHEN status='queued' AND held_round=0 THEN 1 ELSE 0 END),0) AS ready,
      COALESCE(SUM(CASE WHEN status='queued' AND held_round>0 THEN 1 ELSE 0 END),0) AS held,
      COALESCE(SUM(CASE WHEN status='queued' AND held_round=0 AND case_type='ddt' THEN 1 ELSE 0 END),0) AS ddt
    FROM execution_runs WHERE batch_id=${batchId} AND status IN ('queued','assigned','running')
  ) SELECT p.running,p.assigned,p.ready,p.held,
    (b.adapter_runtime_json IS NOT NULL) AS "adapterEnabled",
    COALESCE((${feature("jdk")} AND ${feature("jarBundle")}),FALSE) AS "runtimeAssets",
    (COALESCE(${ddt},FALSE) OR p.ddt>0) AS ddt,
    (SELECT s.concurrency FROM run_batch_retry_concurrency_states s WHERE s.batch_id=b.id) AS "ruleConcurrency",
    EXISTS(SELECT 1 FROM run_batch_round_recoveries rr WHERE rr.batch_id=b.id AND rr.status IN ('pending','polling','waiting','releasing')) AS "recoveryPending"
    FROM run_batches b CROSS JOIN pending p WHERE b.id=${batchId}`;
}

export function runnerReservationsQuery(batchId: string, runnerIds: readonly string[]) {
  return sql`SELECT a.runner_id AS "runnerId", COUNT(*) AS reserved,
    SUM(CASE WHEN r.batch_id=${batchId} THEN 1 ELSE 0 END) AS own
    FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id
    JOIN run_batches b ON b.id=r.batch_id
    WHERE a.runner_id IN (${sql.join(
      runnerIds.map((id) => sql`${id}`),
      sql`,`,
    )})
      AND a.status IN ('assigned','running') AND r.status IN ('assigned','running')
      AND b.status IN ('queued','dispatching','scheduled','running')
    GROUP BY a.runner_id`;
}

export function projectReservationsQuery(projectId: string) {
  return sql`SELECT COUNT(*) AS value FROM run_attempts a
    JOIN execution_runs r ON r.id=a.execution_run_id JOIN run_batches b ON b.id=r.batch_id
    WHERE b.project_id=${projectId} AND b.status IN ('queued','dispatching','scheduled','running')
      AND r.status IN ('assigned','running') AND a.status IN ('assigned','running')`;
}

export function concurrencySnapshot(
  metadata: RunBatchMetadata,
  counts: ConcurrencyCountRow,
  runners: Runner[],
  reservations: RunnerReservationRow[],
  projectActiveRuns: number,
): ConcurrencySnapshot {
  const byRunner = new Map(reservations.map((row) => [row.runnerId, row]));
  return {
    batch: {
      id: metadata.id,
      projectId: metadata.projectId,
      status: metadata.status,
      scheduledFor: metadata.scheduledFor,
      ...(metadata.terminationRequestedAt
        ? { terminationRequestedAt: metadata.terminationRequestedAt }
        : {}),
      ...(metadata.policy ? { policy: metadata.policy } : {}),
    },
    targetConcurrency: counts.ruleConcurrency ?? metadata.policy?.concurrency ?? null,
    runningRuns: Number(counts.running),
    assignedRuns: Number(counts.assigned),
    readyRuns: Number(counts.ready),
    heldRuns: Number(counts.held),
    recoveryPending: !!counts.recoveryPending,
    projectActiveRuns,
    requiredCapabilities: projectAdapterCapabilitiesForFeatures({
      adapterEnabled: !!counts.adapterEnabled,
      projectRuntimeAssets: !!counts.runtimeAssets,
      ddtCaseId: !!counts.ddt,
    }),
    omittedNodes: Math.max(0, metadata.selectedRunnerIds.length - 64),
    nodes: runners.map((runner) => ({
      runner,
      reservedSlots: Number(byRunner.get(runner.id)?.reserved ?? 0),
      batchReservedSlots: Number(byRunner.get(runner.id)?.own ?? 0),
    })),
  };
}
