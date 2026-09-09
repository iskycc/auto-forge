import { DomainError, type AuthenticatedIdentity, type DdtScope } from "@autoforge/domain";
import type { PlatformServices } from "./services";
import type { DdtCaseDetailView } from "./ddt-case-detail-view";
import { loadCaseDetail } from "./load-case-detail";

export async function loadDdtCaseDetail(
  services: PlatformServices,
  identity: AuthenticatedIdentity,
  scope: DdtScope,
  caseId: string,
): Promise<DdtCaseDetailView> {
  const item = await services.ddtCases.getSummary(scope, caseId);
  if (!item.executionClass) {
    throw new DomainError(
      "DDT_EXECUTION_CLASS_REQUIRED",
      "当前用例尚未关联执行类，请先配置 SR 测试类关联。",
    );
  }
  const base = `/api/v1/ddt/cases/${encodeURIComponent(item.caseId)}`;
  const query = new URLSearchParams(scope);
  const detail = await loadCaseDetail(
    services,
    identity,
    item.executionClass.caseDefinitionId,
    [scope.projectId],
    {
      caseDefinitionId: item.id,
      executionHistoryUrl: `${base}/executions?${query}`,
      analysisHistoryUrl: `${base}/failure-analyses?${query}`,
      activity: () => services.ddtCases.listActivity(scope, item.caseId, 50),
      executions: (historyQuery) =>
        services.ddtCases.listExecutionHistory(scope, item.caseId, historyQuery),
    },
  );
  return { item, executionDetail: { ...detail, canManage: false } };
}
