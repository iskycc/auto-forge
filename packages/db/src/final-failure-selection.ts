import { sql, type SQLWrapper } from "drizzle-orm";

/** Any success wins; otherwise use the latest outcome, falling back to terminal run metadata. */
export function finalRunOutcome(table: {
  id: SQLWrapper;
  terminalOutcome: SQLWrapper;
  status: SQLWrapper;
}) {
  return sql`COALESCE(
    (SELECT COALESCE(attempt.outcome,
              CASE WHEN attempt.status IN ('succeeded','failed','cancelled','timed_out')
                   THEN attempt.status END)
       FROM run_attempts attempt
      WHERE attempt.execution_run_id = ${table.id}
      ORDER BY CASE WHEN COALESCE(attempt.outcome, attempt.status) = 'succeeded'
                    THEN 0 ELSE 1 END,
               attempt.attempt_number DESC
      LIMIT 1),
    ${table.terminalOutcome},
    CASE WHEN ${table.status} IN ('succeeded','failed','cancelled') THEN ${table.status} END
  )`;
}

/** Final summary: any successful attempt wins; otherwise use the latest outcome. */
export function finalFailureRunCondition(table: Parameters<typeof finalRunOutcome>[0]) {
  return sql`${finalRunOutcome(table)} IN ('failed','timed_out')`;
}
