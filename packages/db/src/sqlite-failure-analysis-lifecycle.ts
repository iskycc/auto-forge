import type { FailureAnalysisRepository } from "@autoforge/application";
import {
  requireActiveFailureAnalysisBatch,
  requireFailureAnalysisBatchTransition,
} from "@autoforge/domain";
import { retrySqliteWriteTransaction, type SqliteDatabaseHandle } from "./database";
import {
  analysisLifecycleColumns,
  type FailureAnalysisBatchLifecycle,
} from "./failure-analysis-lifecycle";

type BatchScope = Parameters<FailureAnalysisRepository["closeBatch"]>[0];

function readLifecycle(handle: SqliteDatabaseHandle, input: BatchScope) {
  return handle.client
    .prepare(
      `SELECT ${analysisLifecycleColumns}
    FROM failure_analysis_batches analysis JOIN run_batches batch ON batch.id=analysis.batch_id
    WHERE analysis.batch_id=? AND analysis.project_id=?
      AND json_extract(batch.policy_json,'$.projectVersionId')=?`,
    )
    .get(input.batchId, input.projectId, input.projectVersionId) as
    FailureAnalysisBatchLifecycle | undefined;
}

export function closeSqliteAnalysisBatch(handle: SqliteDatabaseHandle, input: BatchScope) {
  return retrySqliteWriteTransaction(handle, () => {
    const lifecycle = readLifecycle(handle, input);
    if (!lifecycle) return false;
    requireFailureAnalysisBatchTransition("close", lifecycle);
    handle.client
      .prepare("DELETE FROM failure_analysis_claims WHERE batch_id=? AND project_id=?")
      .run(input.batchId, input.projectId);
    handle.client
      .prepare("DELETE FROM failure_analysis_batches WHERE batch_id=? AND project_id=?")
      .run(input.batchId, input.projectId);
    return true;
  });
}

export function archiveSqliteAnalysisBatch(
  handle: SqliteDatabaseHandle,
  input: Parameters<FailureAnalysisRepository["archiveBatch"]>[0],
) {
  return retrySqliteWriteTransaction(handle, () => {
    const lifecycle = readLifecycle(handle, input);
    if (!lifecycle || lifecycle.archivedAt) return false;
    requireFailureAnalysisBatchTransition("archive", lifecycle);
    handle.client
      .prepare(
        "UPDATE failure_analysis_batches SET archived_at=?,archived_by=? WHERE batch_id=? AND project_id=?",
      )
      .run(input.archivedAt, input.archivedBy, input.batchId, input.projectId);
    return true;
  });
}

/** Called inside the same short write transaction as claim creation or mutation. */
export function requireWritableSqliteAnalysisBatch(
  handle: SqliteDatabaseHandle,
  projectId: string,
  batchId: string,
) {
  const row = handle.client
    .prepare(
      "SELECT archived_at AS archivedAt FROM failure_analysis_batches WHERE project_id=? AND batch_id=?",
    )
    .get(projectId, batchId) as { archivedAt: string | null } | undefined;
  requireActiveFailureAnalysisBatch(row?.archivedAt);
}

export function requireWritableSqliteAnalysisClaims(
  handle: SqliteDatabaseHandle,
  projectId: string,
  analysisIds: readonly string[],
) {
  if (!analysisIds.length) return;
  const rows = handle.client
    .prepare(
      `SELECT analysis.archived_at AS archivedAt
    FROM failure_analysis_batches analysis WHERE analysis.project_id=? AND analysis.batch_id IN (
      SELECT batch_id FROM failure_analysis_claims WHERE project_id=? AND id IN (${analysisIds.map(() => "?").join(",")})
    )`,
    )
    .all(projectId, projectId, ...analysisIds) as Array<{ archivedAt: string | null }>;
  for (const row of rows) requireActiveFailureAnalysisBatch(row.archivedAt);
}

export function markSqliteAnalysisProgress(
  handle: SqliteDatabaseHandle,
  projectId: string,
  analysisIds: readonly string[],
  at: string,
) {
  if (!analysisIds.length) return;
  handle.client
    .prepare(
      `UPDATE failure_analysis_batches SET progress_started_at=?
    WHERE project_id=? AND progress_started_at IS NULL AND batch_id IN (
      SELECT batch_id FROM failure_analysis_claims WHERE project_id=? AND id IN (${analysisIds.map(() => "?").join(",")})
    )`,
    )
    .run(at, projectId, projectId, ...analysisIds);
}
