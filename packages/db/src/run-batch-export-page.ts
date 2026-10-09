import { sql, type SQL } from "drizzle-orm";
import type { RunBatchExportPage, RunBatchExportPageQuery } from "@autoforge/application";
import type { RunAttempt } from "@autoforge/domain";

type ExportRecord = {
  runId: string;
  className: string;
  displayName: string;
  attemptId: string;
  attemptNumber: number;
  round: number;
  status: RunAttempt["status"];
  outcome: RunAttempt["outcome"] | null;
  resultCode: string | null;
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

/** Select latest physical attempts before outcome filtering, so recovered failures stay excluded. */
export function runBatchExportPageQuery(input: RunBatchExportPageQuery): SQL {
  const round = sql`COALESCE(attempt.execution_round,attempt.attempt_number)`;
  const conditions = [sql`run.batch_id=${input.batchId}`];
  if (input.scope === "round") conditions.push(sql`${round}=${input.round}`);
  conditions.push(sql`NOT EXISTS (
    SELECT 1 FROM run_attempts newer WHERE newer.execution_run_id=run.id
      AND newer.attempt_number>attempt.attempt_number
      ${input.scope === "final" ? sql`` : sql`AND COALESCE(newer.execution_round,newer.attempt_number)=${round}`}
  )`);
  if (input.after) {
    const cursor = input.after;
    // This run-only prefix can seek the member index before joining attempts. The full
    // cursor also compares round, retaining further logical rounds of the boundary run.
    conditions.push(
      sql`(run.class_name,run.display_name,run.id) >= (${cursor.className},${cursor.displayName},${cursor.runId})`,
      sql`(run.class_name,run.display_name,run.id,${round}) > (${cursor.className},${cursor.displayName},${cursor.runId},${cursor.round})`,
    );
  }
  return sql`SELECT run.id AS "runId",run.class_name AS "className",run.display_name AS "displayName",
    attempt.id AS "attemptId",attempt.attempt_number AS "attemptNumber",${round} AS round,
    attempt.status,attempt.outcome,attempt.result_code AS "resultCode",attempt.result_summary AS summary,
    attempt.started_at AS "startedAt",attempt.finished_at AS "finishedAt",attempt.duration_ms AS "durationMs"
    FROM execution_runs run JOIN run_attempts attempt ON attempt.execution_run_id=run.id
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY run.class_name,run.display_name,run.id,${round} LIMIT ${Math.min(200, Math.max(1, input.limit)) + 1}`;
}

export function mapRunBatchExportPage(rows: ExportRecord[], limit: number): RunBatchExportPage {
  const pageSize = Math.min(200, Math.max(1, limit));
  const selected = rows.slice(0, pageSize);
  const last = selected.at(-1);
  return {
    items: selected.map((row) => ({
      run: { id: row.runId, className: row.className, displayName: row.displayName },
      attempt: {
        id: row.attemptId,
        executionRunId: row.runId,
        attemptNumber: row.attemptNumber,
        executionRound: row.round,
        status: row.status,
        ...(row.outcome != null ? { outcome: row.outcome } : {}),
        ...(row.resultCode !== null ? { resultCode: row.resultCode } : {}),
        ...(row.summary !== null ? { resultSummary: row.summary } : {}),
        ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
        ...(row.finishedAt !== null ? { finishedAt: row.finishedAt } : {}),
        ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
      },
    })),
    ...(rows.length > pageSize && last
      ? {
          next: {
            className: last.className,
            displayName: last.displayName,
            runId: last.runId,
            round: last.round,
          },
        }
      : {}),
  };
}
