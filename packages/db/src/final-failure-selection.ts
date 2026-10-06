import { sql, type SQLWrapper } from "drizzle-orm";

/** Final summary: any successful attempt wins; otherwise use the latest outcome. */
export function finalFailureRunCondition(table: {
  id: SQLWrapper;
  terminalOutcome: SQLWrapper;
  status: SQLWrapper;
}) {
  return sql`COALESCE(
    (SELECT COALESCE(attempt.outcome, attempt.status)
       FROM run_attempts attempt
      WHERE attempt.execution_run_id = ${table.id}
      ORDER BY CASE WHEN COALESCE(attempt.outcome, attempt.status) = 'succeeded'
                    THEN 0 ELSE 1 END,
               attempt.attempt_number DESC
      LIMIT 1),
    ${table.terminalOutcome},
    CASE WHEN ${table.status} IN ('succeeded','failed','cancelled') THEN ${table.status} END
  ) IN ('failed','timed_out')`;
}
