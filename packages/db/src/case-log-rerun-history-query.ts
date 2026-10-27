import { sql } from "drizzle-orm";

/** Keep Runner history lookups inside one case's diagnostic family. */
function caseLogRerunExecutionRunIds(parentBatchId: string, sourceExecutionRunId: string) {
  return sql`
    SELECT source.id FROM execution_runs source
    WHERE source.batch_id = ${parentBatchId} AND source.id = ${sourceExecutionRunId}
    UNION ALL
    SELECT diagnostic.id FROM run_batches batch
    JOIN execution_runs diagnostic ON diagnostic.batch_id = batch.id
    WHERE batch.batch_kind = 'case_log_rerun' AND batch.parent_batch_id = ${parentBatchId}
      AND batch.source_execution_run_id = ${sourceExecutionRunId}`;
}

/** Manual overrides never become the default environment for the next rerun. */
export function sourceCaseLogAssignmentQuery(parentBatchId: string, sourceExecutionRunId: string) {
  return sql`
    SELECT assignment.execution_spec_json AS "executionSpecJson"
    FROM assignments assignment
    WHERE assignment.attempt_id IN (
      SELECT attempt.id FROM run_attempts attempt
      WHERE attempt.execution_run_id IN (
        SELECT source.id FROM execution_runs source
        WHERE source.batch_id = ${parentBatchId} AND source.id = ${sourceExecutionRunId}
      )
    )
    ORDER BY assignment.created_at DESC, assignment.id DESC LIMIT 1`;
}

export function previousCaseLogRunnerQuery(parentBatchId: string, sourceExecutionRunId: string) {
  return sql`
    SELECT attempt.runner_id AS "runnerId" FROM run_attempts attempt
    WHERE attempt.execution_run_id IN (${caseLogRerunExecutionRunIds(parentBatchId, sourceExecutionRunId)})
    ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1`;
}
