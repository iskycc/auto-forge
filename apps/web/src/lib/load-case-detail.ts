import { failureAnalysisHistoryPageSchema } from "@autoforge/contracts";
import { DomainError, hasPermission, type AuthenticatedIdentity } from "@autoforge/domain";

import type { CaseDetailView } from "./case-detail-view";
import type { PlatformServices } from "./services";

type CaseDetailServices = {
  caseDefinitions: Pick<
    PlatformServices["caseDefinitions"],
    "get" | "listVersions" | "listActivity" | "listExecutionHistory"
  >;
  caseSources: Pick<PlatformServices["caseSources"], "executable">;
  projectStructures: Pick<PlatformServices["projectStructures"], "list">;
  failureAnalysis: Pick<PlatformServices["failureAnalysis"], "listCaseHistory">;
  configurationStore: Pick<PlatformServices["configurationStore"], "read">;
};

// Both entrypoints use the same bounded history windows and permission decisions.
// Source content remains lazy so opening a preview never reads or decompiles a JAR.
export async function loadCaseDetail(
  services: CaseDetailServices,
  identity: AuthenticatedIdentity,
  caseDefinitionId: string,
  projectIds: readonly string[] | undefined,
): Promise<CaseDetailView> {
  const definition = await services.caseDefinitions.get(caseDefinitionId, projectIds);
  const [versions, activity, executionHistory, failureAnalysisHistory, structure, executable] =
    await Promise.all([
      services.caseDefinitions.listVersions(caseDefinitionId, projectIds),
      services.caseDefinitions.listActivity(caseDefinitionId, projectIds, 50),
      services.caseDefinitions.listExecutionHistory(caseDefinitionId, projectIds, {
        limit: 50,
        includeRunnerNames: hasPermission(identity, "runner.read"),
      }),
      services.failureAnalysis.listCaseHistory({
        projectId: definition.projectId,
        caseDefinitionId,
        limit: 20,
      }),
      services.projectStructures.list(definition.projectId),
      services.caseSources.executable(definition.sourceId, projectIds),
    ]);
  const projectVersion = structure.versions.find(
    (version) => version.id === definition.projectVersionId,
  );
  const testStage = projectVersion?.stages.find((stage) => stage.id === definition.testStageId);
  if (!projectVersion || !testStage) {
    throw new DomainError("CASE_DEFINITION_NOT_FOUND", "用例所属版本或测试阶段不存在。");
  }
  return {
    definition,
    versions,
    activity,
    executionHistory,
    failureAnalysisHistory: failureAnalysisHistoryPageSchema.parse(failureAnalysisHistory),
    projectVersionName: projectVersion.name,
    testStageName: testStage.name,
    executable,
    canManage: hasPermission(identity, "case.manage", definition.projectId),
    canRun: hasPermission(identity, "run.create", definition.projectId),
    canReadLogs: hasPermission(identity, "log.read", definition.projectId),
    canReadSource: hasPermission(identity, "case_source.read", definition.projectId),
    canReadAnalysisEvidence: hasPermission(identity, "run.read", definition.projectId),
    timeZone: services.configurationStore.read().web.timeZone,
  };
}
