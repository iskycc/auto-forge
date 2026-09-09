import type { FailureAnalysisExecution } from "@autoforge/contracts";
import { FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS } from "./failure-analysis-shared";

export type FailureAnalysisExecutionRow = {
  executionRunId: string;
  batchId: string;
  batchSequenceNumber: number | string;
  caseVersion: number;
  outcome: FailureAnalysisExecution["outcome"];
  createdAt: string;
  finishedAt: string | null;
  attemptId: string | null;
  attemptNumber: number | null;
  resultSummary: string | null;
};

export type FailureAnalysisRecentSuccessRow = {
  referenceId: string;
  batchId: string;
  batchSequenceNumber: number | string;
  createdAt: string;
};

// 两种方言共享筛选规则；参数顺序为项目、本次批次、用例、数量。
export function previousExecutionsSql(
  placeholders: readonly [string, string, string, string],
): string {
  const [projectId, batchId, caseDefinitionId, limit] = placeholders;
  return `WITH anchor AS (
    SELECT id,suite_id,project_id,created_at,sequence_number FROM run_batches
    WHERE project_id=${projectId} AND id=${batchId}
  )
  SELECT run.id AS "executionRunId",batch.id AS "batchId",
         batch.sequence_number AS "batchSequenceNumber",run.case_version AS "caseVersion",
         COALESCE(run.terminal_outcome,run.status) AS outcome,
         batch.created_at AS "createdAt",attempt.finished_at AS "finishedAt",
         attempt.id AS "attemptId",attempt.attempt_number AS "attemptNumber",
         SUBSTR(COALESCE(attempt.result_summary,''),1,${FAILURE_ANALYSIS_SUMMARY_MAXIMUM_CHARACTERS}) AS "resultSummary"
  FROM execution_runs run
  JOIN run_batches batch ON batch.id=run.batch_id
  JOIN anchor ON batch.suite_id=anchor.suite_id AND batch.project_id=anchor.project_id
  LEFT JOIN run_attempts attempt ON attempt.id=(
    SELECT latest.id FROM run_attempts latest
    WHERE latest.execution_run_id=run.id AND latest.execution_round=run.execution_round
    ORDER BY latest.attempt_number DESC LIMIT 1
  )
  WHERE run.case_definition_id=${caseDefinitionId}
    AND run.status IN ('succeeded','failed','cancelled')
    AND batch.status IN ('succeeded','failed','cancelled')
    AND batch.batch_kind='standard' AND batch.id<>anchor.id
    AND (batch.created_at<anchor.created_at OR
         (batch.created_at=anchor.created_at AND batch.sequence_number<anchor.sequence_number))
  ORDER BY batch.created_at DESC,batch.sequence_number DESC,batch.id DESC
  LIMIT ${limit}`;
}

/**
 * Find the newest successful execution within each anchor's bounded number of
 * recent earlier standard task executions. The caller supplies a target CTE
 * for the current claim page so both database modes use one set-based query.
 */
export function recentSuccessfulExecutionsSql(input: {
  targetsSql: string;
  projectIdPlaceholder: string;
  limitPlaceholder: string;
}): string {
  return `WITH target(reference_id,batch_id,case_definition_id) AS (${input.targetsSql}),
  anchor AS (
    SELECT target.reference_id,target.case_definition_id,
           batch.suite_id,batch.project_id,batch.created_at,batch.sequence_number
    FROM target JOIN run_batches batch ON batch.id=target.batch_id
    WHERE batch.project_id=${input.projectIdPlaceholder}
  ),
  ranked_history AS (
    SELECT anchor.reference_id,batch.id AS batch_id,
           batch.sequence_number,batch.created_at,
           COALESCE(run.terminal_outcome,run.status) AS outcome,
           ROW_NUMBER() OVER (
             PARTITION BY anchor.reference_id
             ORDER BY batch.created_at DESC,batch.sequence_number DESC,batch.id DESC
           ) AS recent_rank
    FROM anchor
    JOIN run_batches batch
      ON batch.suite_id=anchor.suite_id AND batch.project_id=anchor.project_id
    JOIN execution_runs run
      ON run.batch_id=batch.id AND run.case_definition_id=anchor.case_definition_id
    WHERE run.status IN ('succeeded','failed','cancelled')
      AND batch.status IN ('succeeded','failed','cancelled')
      AND batch.batch_kind='standard'
      AND (batch.created_at<anchor.created_at OR
           (batch.created_at=anchor.created_at AND batch.sequence_number<anchor.sequence_number))
  ),
  latest_success AS (
    SELECT reference_id,MIN(recent_rank) AS recent_rank
    FROM ranked_history
    WHERE recent_rank<=${input.limitPlaceholder} AND outcome='succeeded'
    GROUP BY reference_id
  )
  SELECT history.reference_id AS "referenceId",history.batch_id AS "batchId",
         history.sequence_number AS "batchSequenceNumber",history.created_at AS "createdAt"
  FROM ranked_history history
  JOIN latest_success success
    ON success.reference_id=history.reference_id AND success.recent_rank=history.recent_rank
  ORDER BY history.reference_id ASC`;
}

export function toFailureAnalysisExecution(
  row: FailureAnalysisExecutionRow,
): FailureAnalysisExecution {
  return {
    executionRunId: row.executionRunId,
    batchId: row.batchId,
    batchSequenceNumber: Number(row.batchSequenceNumber),
    caseVersion: row.caseVersion,
    outcome: row.outcome,
    createdAt: row.createdAt,
    resultSummary: row.resultSummary ?? "",
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.attemptId ? { attemptId: row.attemptId } : {}),
    ...(row.attemptNumber !== null ? { attemptNumber: row.attemptNumber } : {}),
  };
}

export function toFailureAnalysisRecentSuccess(row: FailureAnalysisRecentSuccessRow) {
  return {
    referenceId: row.referenceId,
    batchId: row.batchId,
    batchSequenceNumber: Number(row.batchSequenceNumber),
    createdAt: row.createdAt,
  };
}
