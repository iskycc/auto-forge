import type { FailureAnalysisInheritanceScope } from "@autoforge/contracts";
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

// Select batches before searching claims: a batch without a completed conclusion still
// occupies one of the five slots, and multiple cases never consume extra slots.
export function recentTaskAnalysisBatchIdsSql(anchorBatchId: string): string {
  return `SELECT history_batch.id FROM run_batches history_batch
    JOIN run_batches anchor_batch ON history_batch.project_id=anchor_batch.project_id
      AND history_batch.suite_id=anchor_batch.suite_id
    WHERE anchor_batch.id=${anchorBatchId} AND anchor_batch.suite_id<>''
      AND history_batch.batch_kind='standard'
      AND history_batch.status IN ('succeeded','failed','cancelled')
      AND (history_batch.created_at<anchor_batch.created_at OR
        (history_batch.created_at=anchor_batch.created_at
          AND history_batch.sequence_number<anchor_batch.sequence_number))
    ORDER BY history_batch.created_at DESC,history_batch.sequence_number DESC,history_batch.id DESC
    LIMIT 5`;
}

export function analysisInheritanceScopeSql(
  scope: FailureAnalysisInheritanceScope = "same_case",
): string {
  const sourceScope =
    scope === "task_recent_batches"
      ? `source_claim.batch_id IN (${recentTaskAnalysisBatchIdsSql("target_batch.id")})`
      : "source_claim.case_definition_id=target_claim.case_definition_id";
  return `
  FROM failure_analysis_claims target_claim
  JOIN run_batches target_batch ON target_batch.id=target_claim.batch_id
  JOIN failure_analysis_claims source_claim
    ON source_claim.project_id=target_claim.project_id
    AND source_claim.id<>target_claim.id
    AND source_claim.status='completed' AND source_claim.completed_at IS NOT NULL
  JOIN run_batches source_batch ON source_batch.id=source_claim.batch_id
    AND source_batch.project_id=source_claim.project_id
  WHERE ${sameTaskSql} AND ${sourceScope}`;
}

export function requireMatchingAnalysisInheritance(
  matchedCount: number,
  targetCount: number,
  scope: FailureAnalysisInheritanceScope = "same_case",
): void {
  if (targetCount === 0 || matchedCount !== targetCount) {
    throw new DomainError(
      "FAILURE_ANALYSIS_INHERITANCE_SCOPE_INVALID",
      scope === "task_recent_batches"
        ? "只能继承本任务此前最近 5 次批跑中的已完成分析结论，请刷新历史结论后重试。"
        : "只能继承同一任务中同一用例的已完成分析结论，请刷新历史结论后重试。",
    );
  }
}

// Rank narrow claim metadata before paging; only selected latest claims load full text/images.
// A search match on an older conclusion retains the case's actual latest conclusion.
export function taskConclusionCasesCteSql(input: {
  projectId: string;
  batchId: string;
  searchMatch: string;
  cursorCondition: string;
  limit: string;
}): string {
  return `WITH ranked_conclusions AS (
    SELECT claim.id,claim.case_definition_id,claim.completed_at,
      ROW_NUMBER() OVER (PARTITION BY claim.case_definition_id ORDER BY claim.completed_at DESC,claim.id DESC) AS conclusion_rank,
      COUNT(*) OVER (PARTITION BY claim.case_definition_id) AS conclusion_count,
      MAX(CASE WHEN ${input.searchMatch} THEN 1 ELSE 0 END) OVER (PARTITION BY claim.case_definition_id) AS search_match
    FROM failure_analysis_claims claim
    WHERE claim.project_id=${input.projectId}
      AND claim.batch_id IN (${recentTaskAnalysisBatchIdsSql(input.batchId)})
      AND claim.status='completed' AND claim.completed_at IS NOT NULL
  ), latest_conclusions AS (
    SELECT * FROM ranked_conclusions ranked
    WHERE conclusion_rank=1 AND search_match=1 AND ${input.cursorCondition}
    ORDER BY ranked.completed_at DESC,ranked.id DESC LIMIT ${input.limit}
  )`;
}

export function taskConclusionSearchSql(
  placeholder: string,
  dialect: "sqlite" | "postgres",
): string {
  const columns = [
    "case_name",
    "class_name",
    "failure_summary",
    "issue_description",
    "ticket_reference",
    "remark",
  ];
  return `(${columns
    .map((column) =>
      dialect === "postgres"
        ? `COALESCE(claim.${column},'') ILIKE ${placeholder} ESCAPE '\\'`
        : `LOWER(COALESCE(claim.${column},'')) LIKE ${placeholder} ESCAPE '\\'`,
    )
    .join(" OR ")})`;
}
