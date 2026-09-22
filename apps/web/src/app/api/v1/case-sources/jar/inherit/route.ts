import { NextResponse } from "next/server";
import { inheritTestNgCasesInputSchema, testNgInheritancePageSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { workDispatcher } from "@/lib/work-runtime";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = inheritTestNgCasesInputSchema.parse(await readJsonBody(request, 8 * 1_024));
    authorizedProjectScope(identity, "case_source.manage", input.projectId);
    authorizedProjectScope(identity, "case.read", input.projectId);
    const services = await getPlatformServices();
    const structure = await services.projectStructures.list(input.projectId);
    for (const [versionId, stageId] of [
      [input.sourceProjectVersionId, input.sourceTestStageId],
      [input.targetProjectVersionId, input.targetTestStageId],
    ]) {
      if (
        !structure.versions
          .find((version) => version.id === versionId)
          ?.stages.some((stage) => stage.id === stageId)
      )
        throw new DomainError(
          "CASE_IMPORT_STAGE_REQUIRED",
          "来源和目标必须是当前项目下有效的版本与测试阶段。",
        );
    }
    const dispatcher = workDispatcher();
    if (!dispatcher?.inheritTestNgCases)
      throw new DomainError("PLATFORM_BUSY", "继承服务暂时不可用，请稍后重试。");
    const result = testNgInheritancePageSchema.parse(
      await dispatcher.inheritTestNgCases(
        {
          ...input,
          // Service accounts are audited separately and are not rows in users.
          ...(identity.sessionId.startsWith("api-token:") ? {} : { actorId: identity.user.id }),
        },
        request.signal,
      ),
    );
    if (result.inheritedCount) await services.readModels.invalidate(input.projectId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_definition.inherit_version",
      resourceType: "project_version",
      resourceId: input.targetProjectVersionId,
      projectId: input.projectId,
      requestId: currentRequestId,
      details: {
        sourceProjectVersionId: input.sourceProjectVersionId,
        sourceTestStageId: input.sourceTestStageId,
        targetTestStageId: input.targetTestStageId,
        inheritedCount: result.inheritedCount,
        skippedCount: result.skippedCount,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
