import { sql } from "drizzle-orm";
import { ADAPTER_FAILURE_RESULT_CODES, ADAPTER_SUCCESS_RESULT_CODES } from "@autoforge/domain";
import type { RunBatchRepository } from "@autoforge/application";
import type { ExecutionException } from "@autoforge/contracts";

const normalResultCodes = sql.join(
  [...ADAPTER_FAILURE_RESULT_CODES, ...ADAPTER_SUCCESS_RESULT_CODES].map((code) => sql`${code}`),
  sql`, `,
);
const abnormalRunCondition = sql`run.status='failed' AND COALESCE(run.terminal_reason_code,'') NOT IN (${normalResultCodes})`;
const lastMatchingAttemptCondition = sql`attempt.execution_run_id=run.id
  AND COALESCE(attempt.result_code,'')=COALESCE(run.terminal_reason_code,'')
  AND COALESCE(attempt.outcome,attempt.status)=COALESCE(run.terminal_outcome,run.status)
  AND NOT EXISTS (SELECT 1 FROM run_attempts newer
    WHERE newer.execution_run_id=run.id AND newer.attempt_number>attempt.attempt_number)`;

export type ExceptionRecordRow = Omit<ExecutionException, "affectsBatchStatus"> & {
  affectsBatchStatus: number;
};
export type ExceptionCompletionRow = {
  status: "queued" | "assigned" | "running" | "succeeded" | "failed" | "cancelled";
  abnormal: number;
  count: number | string;
};

/** SQL is shared by both dialects; only bounded diagnostic fields leave the database. */
export function executionExceptionQueries(
  input: Parameters<RunBatchRepository["readExceptionRecords"]>[0],
) {
  const completions = sql`SELECT status,abnormal,COUNT(*) AS count FROM (
    SELECT run.status,CASE WHEN ${abnormalRunCondition} THEN 1 ELSE 0 END AS abnormal
    FROM execution_runs run WHERE run.batch_id=${input.batchId}
  ) completion_groups GROUP BY status,abnormal`;
  const filters = [];
  if (input.scope === "terminal") filters.push(sql`"affectsBatchStatus"=1`);
  if (input.after)
    filters.push(sql`("occurredAt" > ${input.after.occurredAt}
      OR ("occurredAt" = ${input.after.occurredAt} AND id > ${input.after.id}))`);
  const where = filters.length ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
  const records = sql`WITH batch_runs AS (
    SELECT id,display_name,class_name,status,execution_round,terminal_outcome,terminal_reason_code,updated_at
    FROM execution_runs WHERE batch_id=${input.batchId}
  ), exceptions AS (
    SELECT 'attempt:' || attempt.id AS id, 'attempt' AS kind,
      attempt.execution_round AS round,attempt.attempt_number AS "attemptNumber",run.id AS "runId",
      run.display_name AS "caseName",run.class_name AS "className",
      CASE WHEN NULLIF(TRIM(attempt.result_code),'') IS NULL THEN 'UNKNOWN_RESULT'
        ELSE attempt.result_code END AS "resultCode",
      SUBSTR(COALESCE(NULLIF(TRIM(attempt.result_summary),''),NULLIF(TRIM(attempt.result_code),''),'执行机未提供错误描述。'),1,8192) AS summary,
      COALESCE(attempt.finished_at,attempt.created_at) AS "occurredAt",
      CASE WHEN ${abnormalRunCondition} AND ${lastMatchingAttemptCondition} THEN 1 ELSE 0 END AS "affectsBatchStatus"
    FROM run_attempts attempt JOIN batch_runs run ON run.id=attempt.execution_run_id
    WHERE COALESCE(attempt.outcome,attempt.status)='timed_out'
      OR (COALESCE(attempt.outcome,attempt.status)='failed' AND COALESCE(attempt.result_code,'') NOT IN (${normalResultCodes}))
    UNION ALL
    SELECT 'run:' || run.id,'run',run.execution_round,NULL,run.id,run.display_name,run.class_name,
      CASE WHEN NULLIF(TRIM(run.terminal_reason_code),'') IS NULL THEN 'UNKNOWN_RESULT'
        ELSE run.terminal_reason_code END,'执行在生成本次尝试前或控制面恢复阶段结束。',run.updated_at,1
    FROM batch_runs run WHERE ${abnormalRunCondition}
      AND NOT EXISTS (SELECT 1 FROM run_attempts attempt WHERE ${lastMatchingAttemptCondition})
    UNION ALL
    SELECT 'recovery:' || rule_id,'recovery',after_round,NULL,NULL,NULL,NULL,
      'JENKINS_ROUND_RECOVERY_FAILED',SUBSTR(COALESCE(NULLIF(TRIM(error_message),''),'轮次环境恢复失败。'),1,8192),
      COALESCE(finished_at,updated_at),1
    FROM run_batch_round_recoveries WHERE batch_id=${input.batchId} AND status='failed'
  ) SELECT * FROM exceptions ${where} ORDER BY "occurredAt",id LIMIT ${input.limit}`;
  return { records, completions };
}

export function mapExecutionExceptionRecords(
  items: ExceptionRecordRow[],
  completions: ExceptionCompletionRow[],
) {
  return {
    items: items.map((row) => ({
      ...row,
      summary: row.summary.slice(0, 8192),
      affectsBatchStatus: Number(row.affectsBatchStatus) === 1,
    })),
    completions: completions.map((row) => ({
      ...row,
      count: Number(row.count),
      abnormal: Number(row.abnormal) === 1,
    })),
  };
}
