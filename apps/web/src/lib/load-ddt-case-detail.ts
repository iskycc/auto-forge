import { failureAnalysisHistoryPageSchema } from "@autoforge/contracts";
import { hasPermission, type AuthenticatedIdentity, type DdtScope } from "@autoforge/domain";
import type { PlatformServices } from "./services";
import type { DdtCaseDetailView } from "./ddt-case-detail-view";
import { loadCaseDetail } from "./load-case-detail";

type DdtDetailServices = Parameters<typeof loadCaseDetail>[0] & {
  ddtCases: Pick<
    PlatformServices["ddtCases"],
    "getSummary" | "listActivity" | "listExecutionHistory"
  >;
};

export async function loadDdtCaseDetail(
  services: DdtDetailServices,
  identity: AuthenticatedIdentity,
  scope: DdtScope,
  caseId: string,
): Promise<DdtCaseDetailView> {
  const item = await services.ddtCases.getSummary(scope, caseId);
  const base = `/api/v1/ddt/cases/${encodeURIComponent(item.caseId)}`;
  const query = new URLSearchParams(scope);
  const historyContext = {
    caseDefinitionId: item.id,
    executionHistoryUrl: `${base}/executions?${query}`,
    analysisHistoryUrl: `${base}/failure-analyses?${query}`,
  };
  // An SR mapping controls future execution, not access to the DDT case's own history.
  if (!item.executionClass) {
    const [activity, executionHistory, failureAnalysisHistory] = await Promise.all([
      services.ddtCases.listActivity(scope, item.caseId, 50),
      services.ddtCases.listExecutionHistory(scope, item.caseId, {
        limit: 50,
        includeRunnerNames: hasPermission(identity, "runner.read"),
      }),
      services.failureAnalysis.listCaseHistory({
        projectId: scope.projectId,
        caseDefinitionId: item.id,
        limit: 20,
      }),
    ]);
    return {
      item,
      historyDetail: {
        activity,
        executionHistory,
        failureAnalysisHistory: failureAnalysisHistoryPageSchema.parse(failureAnalysisHistory),
        historyContext,
        canRun: false,
        canReadLogs: hasPermission(identity, "log.read", scope.projectId),
        canReadAnalysisEvidence: hasPermission(identity, "run.read", scope.projectId),
        timeZone: services.configurationStore.read().web.timeZone,
      },
    };
  }
  const detail = await loadCaseDetail(
    services,
    identity,
    item.executionClass.caseDefinitionId,
    [scope.projectId],
    {
      ...historyContext,
      activity: () => services.ddtCases.listActivity(scope, item.caseId, 50),
      executions: (historyQuery) =>
        services.ddtCases.listExecutionHistory(scope, item.caseId, historyQuery),
    },
  );
  return { item, executionDetail: { ...detail, canManage: false } };
}
