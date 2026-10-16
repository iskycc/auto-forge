import { sql } from "drizzle-orm";
import { finalRunOutcome } from "./final-failure-selection";

export type RunBatchCountRow = {
  batchId: string;
  status: string;
  finalOutcome: string | null;
  value: number | string;
};

export type FinalOutcomeCounts = {
  batchId: string;
  succeeded: number;
  failed: number;
  timedOut: number;
  cancelled: number;
};

export type RunBatchCounts = {
  statusRows: Array<{ batchId: string; status: string; value: number }>;
  outcomeRows: FinalOutcomeCounts[];
};

/** One row per run before counting, even when historical attempt_count is out of sync. */
export function runBatchCountsQuery(batchIds: readonly string[]) {
  const outcome = finalRunOutcome({
    id: sql`run.id`,
    terminalOutcome: sql`run.terminal_outcome`,
    status: sql`run.status`,
  });
  return sql`SELECT run.batch_id AS "batchId", run.status, ${outcome} AS "finalOutcome",
    COUNT(*) AS value FROM execution_runs run
    WHERE run.batch_id IN (${sql.join(
      batchIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    GROUP BY 1, 2, 3`;
}

export function mapRunBatchCounts(rows: readonly RunBatchCountRow[]): RunBatchCounts {
  const statusesByBatch = new Map<string, Map<string, number>>();
  const outcomesByBatch = new Map<string, FinalOutcomeCounts>();
  for (const row of rows) {
    const value = Number(row.value);
    const statuses = statusesByBatch.get(row.batchId) ?? new Map<string, number>();
    statuses.set(row.status, (statuses.get(row.status) ?? 0) + value);
    statusesByBatch.set(row.batchId, statuses);
    const outcomes = outcomesByBatch.get(row.batchId) ?? {
      batchId: row.batchId,
      succeeded: 0,
      failed: 0,
      timedOut: 0,
      cancelled: 0,
    };
    if (row.finalOutcome === "succeeded") outcomes.succeeded += value;
    else if (row.finalOutcome === "failed") outcomes.failed += value;
    else if (row.finalOutcome === "timed_out") outcomes.timedOut += value;
    else if (row.finalOutcome === "cancelled") outcomes.cancelled += value;
    outcomesByBatch.set(row.batchId, outcomes);
  }
  return {
    statusRows: [...statusesByBatch.entries()].flatMap(([batchId, statuses]) =>
      [...statuses.entries()].map(([status, value]) => ({ batchId, status, value })),
    ),
    outcomeRows: [...outcomesByBatch.values()],
  };
}
