import type { CaseSuiteStatisticsQuery } from "@autoforge/application";
import {
  caseSuiteExecutionStatisticsSchema,
  type CaseSuiteExecutionStatistics,
} from "@autoforge/contracts";
import { sql, type SQL } from "drizzle-orm";

export type CaseSuiteStatisticsRow = {
  suiteId: string;
  executionCount: number | string;
  completedExecutionCount: number | string;
  averagePassRate: number | string | null;
  averagePassedCases: number | string | null;
};

/** Both dialects aggregate authoritative results without transferring runs or attempts to JS. */
export function caseSuiteStatisticsQuery(
  input: CaseSuiteStatisticsQuery,
  projectVersionExpression: SQL,
): SQL {
  const suiteIds = sql.join(
    input.suiteIds.map((id) => sql`${id}`),
    sql`, `,
  );
  // Match execution history: any successful attempt wins; only runs without attempts
  // fall back to their terminal outcome. Retries must never count as extra cases.
  const passedCases = sql`(
    SELECT COUNT(*) FROM execution_runs run
    WHERE run.batch_id = batch.id AND (
      EXISTS (
        SELECT 1 FROM run_attempts attempt
        WHERE attempt.execution_run_id = run.id
          AND COALESCE(attempt.outcome, attempt.status) = 'succeeded'
      ) OR (
        COALESCE(run.terminal_outcome, run.status) = 'succeeded'
        AND NOT EXISTS (SELECT 1 FROM run_attempts attempt WHERE attempt.execution_run_id = run.id)
      )
    )
  )`;
  return sql`
    WITH selected_batches AS MATERIALIZED (
      SELECT batch.suite_id, batch.total_runs,
        CASE WHEN batch.status IN ('succeeded', 'failed', 'cancelled')
          THEN 1 ELSE 0 END AS completed,
        CASE WHEN batch.status IN ('succeeded', 'failed', 'cancelled') AND batch.total_runs > 0
          THEN ${passedCases} ELSE NULL END AS passed_cases
      FROM run_batches batch
      WHERE batch.project_id = ${input.projectId}
        AND ${projectVersionExpression} = ${input.projectVersionId}
        AND batch.suite_id IN (${suiteIds})
        AND batch.batch_kind <> 'case_log_rerun'
        AND batch.created_at >= ${input.windowStartedAt}
        AND batch.created_at <= ${input.generatedAt}
    )
    SELECT suite_id AS "suiteId", COUNT(*) AS "executionCount",
      SUM(completed) AS "completedExecutionCount",
      AVG(100.0 * passed_cases / NULLIF(total_runs, 0)) AS "averagePassRate",
      AVG(1.0 * passed_cases) AS "averagePassedCases"
    FROM selected_batches GROUP BY suite_id
  `;
}

export function caseSuiteStatisticsFromRow(
  row: CaseSuiteStatisticsRow,
): CaseSuiteExecutionStatistics {
  return caseSuiteExecutionStatisticsSchema.parse({
    suiteId: row.suiteId,
    executionCount: Number(row.executionCount),
    completedExecutionCount: Number(row.completedExecutionCount),
    averagePassRate: row.averagePassRate === null ? null : Number(row.averagePassRate),
    averagePassedCases: row.averagePassedCases === null ? null : Number(row.averagePassedCases),
  });
}
