import { DomainError } from "@autoforge/domain";
import type { CaseExecutionHistoryPage, CaseExecutionHistoryQuery } from "@autoforge/application";
import { sql, type SQL } from "drizzle-orm";

const CURSOR_SEPARATOR = "|";

export type CaseExecutionHistoryCursor = { createdAt: string; runId: string };

export type CaseExecutionHistoryRow = {
  runId: string;
  batchId: string;
  batchSequenceNumber: number;
  batchName: string;
  status: CaseExecutionHistoryPage["items"][number]["status"];
  createdAt: string;
  attemptId: string;
  attemptNumber: number;
  executionRound: number;
  attemptStatus: CaseExecutionHistoryPage["items"][number]["attempts"][number]["status"];
  runnerId: string;
  runnerName: string | null;
  resultCode: string | null;
  durationMs: number | string | null;
  attemptCreatedAt: string;
  finishedAt: string;
};

export function caseExecutionHistoryPageQuery(
  caseDefinitionId: string,
  query: CaseExecutionHistoryQuery,
): SQL {
  const cursor = decodeCaseExecutionHistoryCursor(query.cursor);
  return sql`SELECT r.id AS "runId", r.batch_id AS "batchId", r.status,
      r.created_at AS "createdAt", b.sequence_number AS "batchSequenceNumber",
      b.suite_name AS "batchName", a.id AS "attemptId", a.attempt_number AS "attemptNumber",
      a.execution_round AS "executionRound", a.status AS "attemptStatus",
      a.runner_id AS "runnerId", runner.name AS "runnerName", a.result_code AS "resultCode",
      a.duration_ms AS "durationMs", a.created_at AS "attemptCreatedAt", a.finished_at AS "finishedAt"
    FROM execution_runs r
    JOIN run_batches b ON b.id = r.batch_id
    JOIN run_attempts a ON a.id = (
      SELECT preferred.id FROM run_attempts preferred
      WHERE preferred.execution_run_id = r.id
      ORDER BY CASE WHEN COALESCE(preferred.outcome, preferred.status) = 'succeeded' THEN 0 ELSE 1 END,
        preferred.attempt_number DESC
      LIMIT 1
    )
    LEFT JOIN runners runner ON runner.id = a.runner_id
    WHERE r.case_definition_id = ${caseDefinitionId} AND b.batch_kind <> 'case_log_rerun'
      AND r.status IN ('succeeded', 'failed')
      AND COALESCE(r.terminal_outcome, r.status) IN ('succeeded', 'failed', 'timed_out')
      AND a.status IN ('succeeded', 'failed', 'timed_out')
      AND COALESCE(a.outcome, a.status) IN ('succeeded', 'failed', 'timed_out')
      AND a.started_at IS NOT NULL AND a.finished_at IS NOT NULL
      ${cursor ? sql`AND (r.created_at < ${cursor.createdAt} OR (r.created_at = ${cursor.createdAt} AND r.id < ${cursor.runId}))` : sql``}
    ORDER BY r.created_at DESC, r.id DESC LIMIT ${query.limit + 1}`;
}

export function mapCaseExecutionHistoryPage(
  rows: readonly CaseExecutionHistoryRow[],
  query: CaseExecutionHistoryQuery,
): CaseExecutionHistoryPage {
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => ({
      runId: row.runId,
      batchId: row.batchId,
      batchSequenceNumber: row.batchSequenceNumber,
      batchName: row.batchName,
      status: row.status,
      createdAt: row.createdAt,
      attempts: [
        {
          id: row.attemptId,
          attemptNumber: row.attemptNumber,
          executionRound: row.executionRound,
          status: row.attemptStatus,
          runnerId: row.runnerId,
          ...(query.includeRunnerNames && row.runnerName ? { runnerName: row.runnerName } : {}),
          ...(row.resultCode ? { resultCode: row.resultCode } : {}),
          ...(row.durationMs === null ? {} : { durationMs: Number(row.durationMs) }),
          createdAt: row.attemptCreatedAt,
          finishedAt: row.finishedAt,
        },
      ],
    })),
    ...(rows.length > query.limit && last
      ? {
          nextCursor: encodeCaseExecutionHistoryCursor({
            createdAt: last.createdAt,
            runId: last.runId,
          }),
        }
      : {}),
  };
}

export function encodeCaseExecutionHistoryCursor(cursor: CaseExecutionHistoryCursor): string {
  return Buffer.from(`${cursor.createdAt}${CURSOR_SEPARATOR}${cursor.runId}`, "utf8").toString(
    "base64url",
  );
}

export function decodeCaseExecutionHistoryCursor(
  value: string | undefined,
): CaseExecutionHistoryCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.indexOf(CURSOR_SEPARATOR);
    if (separator <= 0 || separator === decoded.length - 1) throw new Error("invalid cursor");
    const createdAt = decoded.slice(0, separator);
    const runId = decoded.slice(separator + 1);
    if (Number.isNaN(Date.parse(createdAt)) || runId.length > 128) {
      throw new Error("invalid cursor values");
    }
    return { createdAt, runId };
  } catch (error) {
    throw new DomainError("CASE_EXECUTION_CURSOR_INVALID", "用例执行历史分页游标无效。", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}
