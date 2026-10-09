/** A deleted task remains an analysis source through its immutable execution version. */
export function failureAnalysisTaskHistorySql(
  batchAlias: "batch" | "run_batches" = "batch",
): string {
  return `(EXISTS (SELECT 1 FROM case_suites suite WHERE suite.id=${batchAlias}.suite_id)
    OR EXISTS (SELECT 1 FROM case_suite_versions snapshot
      WHERE snapshot.suite_id=${batchAlias}.suite_id AND snapshot.version=${batchAlias}.suite_version))`;
}
