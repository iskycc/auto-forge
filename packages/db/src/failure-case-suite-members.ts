import type { CopyCaseSuiteRecord } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import { sql } from "drizzle-orm";
import { finalFailureRunCondition } from "./final-failure-selection";

export function failureSuiteMemberQuery(input: {
  batchId: string;
  projectId: string;
  projectVersionId: string;
  afterRunId?: string;
  afterCreatedAt?: string;
  limit?: number;
}) {
  const finalFailure = finalFailureRunCondition({
    id: sql`run.id`,
    terminalOutcome: sql`run.terminal_outcome`,
    status: sql`run.status`,
  });
  return sql`SELECT run.id AS "runId", run.created_at AS "createdAt", run.case_definition_id AS "caseId",
    run.case_type AS "caseType",
    CASE WHEN run.case_type = 'testng' AND definition.id IS NOT NULL
              AND definition.project_id = ${input.projectId}
              AND definition.project_version_id = ${input.projectVersionId}
           OR run.case_type = 'ddt' AND ddt.id IS NOT NULL
              AND ddt.project_id = ${input.projectId}
              AND ddt.project_version_id = ${input.projectVersionId}
         THEN 1 ELSE 0 END AS available
    FROM execution_runs run
    LEFT JOIN case_definitions definition ON definition.id = run.case_definition_id AND run.case_type = 'testng'
    LEFT JOIN ddt_cases ddt ON ddt.id = run.case_definition_id AND run.case_type = 'ddt'
    WHERE run.batch_id = ${input.batchId} AND ${finalFailure}
    ${input.afterRunId && input.afterCreatedAt ? sql`AND (run.created_at, run.id) > (${input.afterCreatedAt}, ${input.afterRunId})` : sql``}
    ${input.limit ? sql`ORDER BY run.created_at, run.id LIMIT ${Math.max(1, Math.min(input.limit, 500))}` : sql``}`;
}

export type FailureCopyValidation = {
  testngCount: number;
  ddtCount: number;
  unavailableCount: number;
  terminal: number;
  activeVersion: number;
};

export function failureCopyValidationQuery(input: CopyCaseSuiteRecord) {
  const selection = failureSuiteMemberQuery({
    batchId: input.failureBatchId!,
    projectId: input.projectId!,
    projectVersionId: input.policy.projectVersionId!,
  });
  return sql`SELECT
    COUNT(DISTINCT CASE WHEN "caseType" = 'testng' THEN "caseId" END) AS "testngCount",
    COUNT(DISTINCT CASE WHEN "caseType" = 'ddt' THEN "caseId" END) AS "ddtCount",
    COALESCE(SUM(CASE WHEN available = 0 THEN 1 ELSE 0 END), 0) AS "unavailableCount",
    CASE WHEN EXISTS(SELECT 1 FROM run_batches WHERE id = ${input.failureBatchId}
      AND project_id = ${input.projectId} AND status IN ('succeeded', 'failed', 'cancelled'))
      THEN 1 ELSE 0 END AS terminal,
    CASE WHEN EXISTS(SELECT 1 FROM project_versions WHERE id = ${input.policy.projectVersionId}
      AND project_id = ${input.projectId} AND status = 'active') THEN 1 ELSE 0 END AS "activeVersion"
    FROM (${selection}) members`;
}

export function assertFailureCopyValidation(
  validation: FailureCopyValidation,
  input: CopyCaseSuiteRecord,
): void {
  if (!Number(validation.terminal))
    throw new DomainError("RUN_BATCH_NOT_TERMINAL", "执行任务完全结束后才能以失败用例创建任务。");
  if (!Number(validation.activeVersion))
    throw new DomainError("PROJECT_VERSION_ARCHIVED", "原项目版本已归档或删除，无法创建任务。");
  if (
    Number(validation.unavailableCount) > 0 ||
    Number(validation.testngCount) !== input.items.length ||
    Number(validation.ddtCount) !== (input.ddtItems?.length ?? 0)
  )
    throw new DomainError(
      "CASE_SUITE_FAILURE_MEMBER_UNAVAILABLE",
      "失败用例范围已变化或包含不可用用例，请刷新后重试。",
    );
}
