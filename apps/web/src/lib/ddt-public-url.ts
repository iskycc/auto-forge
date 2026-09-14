import type { DdtScope } from "@autoforge/domain";

export function ddtPublicApiPath(scope: DdtScope): string {
  return `/api/v1/public/ddt/projects/${encodeURIComponent(scope.projectId)}/versions/${encodeURIComponent(scope.projectVersionId)}/stages/${encodeURIComponent(scope.testStageId)}`;
}

export function ddtPublicCaseUrl(baseUrl: string, caseId: string): string {
  return `${baseUrl}/case?${new URLSearchParams({ caseId: caseId.trim() })}`;
}
