import type { DdtExecutionStatistics } from "@autoforge/contracts";

const DAY_MS = 86_400_000;

export function ddtExecutionWindow(generatedAt: string) {
  const today = Date.parse(`${generatedAt.slice(0, 10)}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) =>
    new Date(today - (6 - index) * DAY_MS).toISOString().slice(0, 10),
  );
}

export type DdtExecutionDayRow = {
  date: string;
  total: number | string;
  passed: number | string;
  failed: number | string;
  cancelled: number | string;
  pending: number | string;
};

/** Aggregate only compact execution columns; never load attempts, logs or case JSON. */
export function ddtExecutionTimelineSql(parameter: (index: number) => string): string {
  return `WITH scoped_cases AS (
    SELECT id FROM ddt_cases
    WHERE project_id=${parameter(1)} AND project_version_id=${parameter(2)} AND test_stage_id=${parameter(3)}
    UNION
    SELECT ddt_case_id AS id FROM ddt_deleted_cases
    WHERE project_id=${parameter(4)} AND project_version_id=${parameter(5)} AND test_stage_id=${parameter(6)}
  )
  SELECT SUBSTR(r.created_at,1,10) AS date, COUNT(*) AS total,
    SUM(CASE WHEN r.terminal_outcome='succeeded' THEN 1 ELSE 0 END) AS passed,
    SUM(CASE WHEN r.terminal_outcome IN ('failed','timed_out') THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN r.terminal_outcome='cancelled' THEN 1 ELSE 0 END) AS cancelled,
    SUM(CASE WHEN r.terminal_outcome IS NULL THEN 1 ELSE 0 END) AS pending
  FROM scoped_cases c JOIN execution_runs r ON r.case_definition_id=c.id
    JOIN run_batches b ON b.id=r.batch_id
  WHERE r.case_type='ddt' AND b.project_id=${parameter(7)} AND b.batch_kind<>'case_log_rerun'
    AND r.created_at>=${parameter(8)} AND r.created_at<=${parameter(9)}
  GROUP BY SUBSTR(r.created_at,1,10) ORDER BY date`;
}

export function ddtExecutionStatistics(
  generatedAt: string,
  rows: DdtExecutionDayRow[],
): DdtExecutionStatistics {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return {
    generatedAt,
    timeline: ddtExecutionWindow(generatedAt).map((date) => {
      const row = byDate.get(date);
      return {
        date,
        total: Number(row?.total ?? 0),
        passed: Number(row?.passed ?? 0),
        failed: Number(row?.failed ?? 0),
        cancelled: Number(row?.cancelled ?? 0),
        pending: Number(row?.pending ?? 0),
      };
    }),
  };
}
