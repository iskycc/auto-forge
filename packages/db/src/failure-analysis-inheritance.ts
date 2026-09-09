import { DomainError } from "@autoforge/domain";

// Task names and test class names are editable and are not identity boundaries.
const sameTaskSql = `source_batch.project_id=target_batch.project_id
  AND source_batch.suite_id=target_batch.suite_id
  AND target_batch.suite_id<>''`;

export function analysisHistoryTaskScopeSql(batchIdPlaceholder: string): string {
  return `EXISTS (
    SELECT 1 FROM run_batches source_batch
    JOIN run_batches target_batch ON ${sameTaskSql}
    WHERE source_batch.id=claim.batch_id
      AND source_batch.project_id=claim.project_id
      AND target_batch.id=${batchIdPlaceholder}
  )`;
}

export const analysisInheritanceScopeSql = `
  FROM failure_analysis_claims target_claim
  JOIN run_batches target_batch ON target_batch.id=target_claim.batch_id
  JOIN failure_analysis_claims source_claim
    ON source_claim.project_id=target_claim.project_id
    AND source_claim.case_definition_id=target_claim.case_definition_id
    AND source_claim.id<>target_claim.id
    AND source_claim.status='completed' AND source_claim.completed_at IS NOT NULL
  JOIN run_batches source_batch ON source_batch.id=source_claim.batch_id
    AND source_batch.project_id=source_claim.project_id
  WHERE ${sameTaskSql}`;

export function requireMatchingAnalysisInheritance(
  matchedCount: number,
  targetCount: number,
): void {
  if (targetCount === 0 || matchedCount !== targetCount) {
    throw new DomainError(
      "FAILURE_ANALYSIS_INHERITANCE_SCOPE_INVALID",
      "只能继承同一任务中同一用例的已完成分析结论，请刷新历史结论后重试。",
    );
  }
}
