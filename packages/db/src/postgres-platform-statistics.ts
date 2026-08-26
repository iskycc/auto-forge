import type {
  PlatformStatisticsRepository,
  PublicPlatformStatisticsSnapshot,
} from "@autoforge/application";

import type { PostgresDatabaseHandle } from "./postgres-database";

type StatisticsRow = Record<keyof PublicPlatformStatisticsSnapshot, string | number | null>;

export class PostgresPlatformStatisticsRepository implements PlatformStatisticsRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async read(onlineSince: string): Promise<PublicPlatformStatisticsSnapshot> {
    const result = await this.handle.pool.query<StatisticsRow>(
      `
        SELECT
          (SELECT COUNT(*) FROM case_sources WHERE lifecycle_status <> 'deleting') AS "sourceCount",
          (SELECT COUNT(*) FROM case_definitions WHERE archived = FALSE) AS "caseCount",
          (SELECT COUNT(*) FROM test_methods) AS "methodCount",
          (SELECT COUNT(*) FROM test_methods WHERE enabled = TRUE) AS "enabledMethodCount",
          (SELECT COUNT(*) FROM runners WHERE deregistered_at IS NULL) AS "runnerCount",
          (SELECT COUNT(*) FROM runners
            WHERE deregistered_at IS NULL AND disabled = FALSE AND last_seen_at >= $1) AS "onlineRunnerCount",
          (SELECT COUNT(*) FROM runners
            WHERE deregistered_at IS NULL AND disabled = FALSE AND last_seen_at >= $1 AND busy_slots > 0) AS "busyRunnerCount",
          (SELECT COUNT(*) FROM run_batches
            WHERE batch_kind <> 'case_log_rerun'
              AND status IN ('queued', 'dispatching', 'scheduled', 'running')) AS "activeBatchCount",
          (SELECT COUNT(*) FROM run_batches
            WHERE batch_kind <> 'case_log_rerun'
              AND status IN ('succeeded', 'failed', 'cancelled')) AS "completedBatchCount",
          (SELECT COUNT(*) FROM execution_runs r JOIN run_batches b ON b.id=r.batch_id
            WHERE b.batch_kind <> 'case_log_rerun') AS "totalRunCount",
          (SELECT COUNT(*) FROM execution_runs r JOIN run_batches b ON b.id=r.batch_id
            WHERE b.batch_kind <> 'case_log_rerun'
              AND r.terminal_outcome = 'succeeded') AS "succeededRunCount",
          (SELECT COUNT(*) FROM execution_runs r JOIN run_batches b ON b.id=r.batch_id
            WHERE b.batch_kind <> 'case_log_rerun'
              AND r.terminal_outcome IN ('failed', 'timed_out')) AS "failedRunCount"
      `,
      [onlineSince],
    );
    const row = result.rows[0];
    if (!row) throw new Error("PostgreSQL 未返回平台统计结果。");
    return numberStatistics(row);
  }
}

function numberStatistics(row: StatisticsRow): PublicPlatformStatisticsSnapshot {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]),
  ) as PublicPlatformStatisticsSnapshot;
}
