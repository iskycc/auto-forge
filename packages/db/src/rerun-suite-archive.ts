import { sql, type SQL } from "drizzle-orm";

export const RERUN_ARCHIVE_PAGE_SIZE = 100;

export function rerunArchiveCandidates(
  projectId: string,
  versionCondition: SQL,
  locked: boolean,
): SQL {
  return sql`SELECT suite.id FROM case_suites suite
    WHERE suite.project_id=${projectId} AND ${versionCondition}
      AND suite.is_rerun=TRUE AND suite.status='active'
      AND NOT EXISTS (SELECT 1 FROM run_batches batch WHERE batch.suite_id=suite.id
        AND batch.status IN ('queued','dispatching','scheduled','running'))
    ORDER BY suite.id LIMIT ${RERUN_ARCHIVE_PAGE_SIZE + 1}
    ${locked ? sql`FOR UPDATE OF suite SKIP LOCKED` : sql``}`;
}

export function busyRerunCount(projectId: string, versionCondition: SQL): SQL {
  return sql`SELECT COUNT(*) AS count FROM case_suites suite
    WHERE suite.project_id=${projectId} AND ${versionCondition}
      AND suite.is_rerun=TRUE AND suite.status='active'
      AND EXISTS (SELECT 1 FROM run_batches batch WHERE batch.suite_id=suite.id
        AND batch.status IN ('queued','dispatching','scheduled','running'))`;
}
