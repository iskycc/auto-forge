import { failureAnalysisHistoryPageSchema } from "@autoforge/contracts";
import { hasPermission } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ caseDefinitionId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    const timeZone = services.configurationStore.read().web.timeZone;
    const projectIds = services.identityAccess.projectScope(identity, "case.read");
    const definition = await services.caseDefinitions.get(caseDefinitionId, projectIds);
    const canManage = hasPermission(identity, "case.manage", definition.projectId);
    const canRun = hasPermission(identity, "run.create", definition.projectId);
    const canReadSource = hasPermission(identity, "case_source.read", definition.projectId);

    const [versions, activity, structure, sourceRecord, failureAnalysisHistory] = await Promise.all(
      [
        services.caseDefinitions.listVersions(caseDefinitionId, projectIds),
        services.caseDefinitions.listActivity(caseDefinitionId, projectIds),
        services.projectStructures.list(definition.projectId),
        services.caseSources.get(definition.sourceId, projectIds),
        services.failureAnalysis.listCaseHistory({
          projectId: definition.projectId,
          caseDefinitionId,
          limit: 10,
        }),
      ],
    );
    const projectVersion = structure.versions.find(
      (version) => version.id === definition.projectVersionId,
    );
    const testStage = projectVersion?.stages.find((stage) => stage.id === definition.testStageId);
    const executable = sourceRecord.inspection.executable !== false;
    let sourceView: Awaited<ReturnType<typeof services.caseSources.readClassSource>> = null;
    let sourceViewError: string | undefined;
    if (canReadSource) {
      try {
        sourceView = await services.caseSources.readClassSource(
          definition.sourceId,
          definition.className,
          projectIds,
        );
      } catch (error) {
        sourceViewError = error instanceof Error ? error.message : "源码读取失败。";
      }
    }

    return NextResponse.json({
      definition,
      versions,
      activity,
      failureAnalysisHistory: failureAnalysisHistoryPageSchema.parse(failureAnalysisHistory),
      canReadAnalysisEvidence: hasPermission(identity, "run.read", definition.projectId),
      timeZone,
      projectVersionName: projectVersion?.name ?? "未归属版本",
      testStageName: testStage?.name ?? "未归属阶段",
      executable,
      canManage,
      canRun,
      canReadSource,
      sourceView,
      ...(sourceViewError ? { sourceViewError } : {}),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
