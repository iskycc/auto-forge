import type { PoolClient } from "pg";
import type { FailureAnalysisRepository } from "@autoforge/application";
import {
  requireActiveFailureAnalysisBatch,
  requireFailureAnalysisBatchTransition,
} from "@autoforge/domain";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { runPostgresTransaction } from "./postgres-transaction";
import {
  analysisLifecycleColumns,
  type FailureAnalysisBatchLifecycle,
} from "./failure-analysis-lifecycle";

type BatchScope = Parameters<FailureAnalysisRepository["closeBatch"]>[0];

async function lockLifecycle(client: PoolClient, input: BatchScope) {
  const result = await client.query<FailureAnalysisBatchLifecycle>(
    `SELECT ${analysisLifecycleColumns}
    FROM failure_analysis_batches analysis JOIN run_batches batch ON batch.id=analysis.batch_id
    WHERE analysis.batch_id=$1 AND analysis.project_id=$2
      AND batch.policy_json::jsonb ->> 'projectVersionId'=$3 FOR UPDATE OF analysis`,
    [input.batchId, input.projectId, input.projectVersionId],
  );
  return result.rows[0];
}

export async function closePostgresAnalysisBatch(
  handle: PostgresDatabaseHandle,
  input: BatchScope,
) {
  await handle.ready;
  return runPostgresTransaction(handle, async (client) => {
    const lifecycle = await lockLifecycle(client, input);
    if (!lifecycle) return false;
    requireFailureAnalysisBatchTransition("close", lifecycle);
    await client.query("DELETE FROM failure_analysis_claims WHERE batch_id=$1 AND project_id=$2", [
      input.batchId,
      input.projectId,
    ]);
    await client.query("DELETE FROM failure_analysis_batches WHERE batch_id=$1 AND project_id=$2", [
      input.batchId,
      input.projectId,
    ]);
    return true;
  });
}

export async function archivePostgresAnalysisBatch(
  handle: PostgresDatabaseHandle,
  input: Parameters<FailureAnalysisRepository["archiveBatch"]>[0],
) {
  await handle.ready;
  return runPostgresTransaction(handle, async (client) => {
    const lifecycle = await lockLifecycle(client, input);
    if (!lifecycle || lifecycle.archivedAt) return false;
    requireFailureAnalysisBatchTransition("archive", lifecycle);
    await client.query(
      "UPDATE failure_analysis_batches SET archived_at=$1,archived_by=$2 WHERE batch_id=$3 AND project_id=$4",
      [input.archivedAt, input.archivedBy, input.batchId, input.projectId],
    );
    return true;
  });
}

/** All mutations lock lifecycle rows before claims, in stable order, so archive/close cannot race a write. */
export async function lockWritablePostgresAnalysisBatch(
  client: PoolClient,
  projectId: string,
  batchId: string,
) {
  const result = await client.query<{ archivedAt: string | null }>(
    'SELECT archived_at AS "archivedAt" FROM failure_analysis_batches WHERE project_id=$1 AND batch_id=$2 FOR UPDATE',
    [projectId, batchId],
  );
  for (const row of result.rows) requireActiveFailureAnalysisBatch(row.archivedAt);
}

export async function lockWritablePostgresAnalysisClaims(
  client: PoolClient,
  projectId: string,
  analysisIds: readonly string[],
) {
  const result = await client.query<{ archivedAt: string | null }>(
    `SELECT analysis.archived_at AS "archivedAt"
    FROM failure_analysis_batches analysis WHERE analysis.project_id=$1 AND analysis.batch_id IN (
      SELECT batch_id FROM failure_analysis_claims WHERE project_id=$1 AND id=ANY($2::text[])
    ) ORDER BY analysis.batch_id FOR UPDATE OF analysis`,
    [projectId, [...analysisIds]],
  );
  for (const row of result.rows) requireActiveFailureAnalysisBatch(row.archivedAt);
}

export async function markPostgresAnalysisProgress(
  client: PoolClient,
  projectId: string,
  analysisIds: readonly string[],
  at: string,
) {
  await client.query(
    `UPDATE failure_analysis_batches SET progress_started_at=$1
    WHERE project_id=$2 AND progress_started_at IS NULL AND batch_id IN (
      SELECT batch_id FROM failure_analysis_claims WHERE project_id=$2 AND id=ANY($3::text[])
    )`,
    [at, projectId, [...analysisIds]],
  );
}
