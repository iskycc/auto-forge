import { NextResponse } from "next/server";
import { createCaseDebugRunSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { authorizeDdtScope } from "@/lib/ddt-api";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { scope, services } = await authorizeDdtScope(
      identity,
      "run.create",
      new URL(request.url),
    );
    services.identityAccess.authorize(identity, "case.read", scope.projectId);
    services.identityAccess.authorize(identity, "run.read", scope.projectId);
    const input = createCaseDebugRunSchema.parse(await readJsonBody(request, 64 * 1_024));
    if (
      input.projectId !== scope.projectId ||
      input.projectVersionId !== scope.projectVersionId ||
      input.testStageId !== scope.testStageId
    ) {
      throw new DomainError("DEBUG_SCOPE_CONFLICT", "执行配置与当前项目、版本、阶段不一致。");
    }
    if (identity.sessionId.startsWith("api-token:"))
      throw new DomainError("DDT_DEBUG_USER_REQUIRED", "请使用个人用户账号进行调试。");
    const batch = await services.runBatches.createDebugCase(input, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "execution.case_debug_create",
      resourceType: "run_batch",
      resourceId: batch.id,
      projectId: scope.projectId,
      requestId: currentRequestId,
      details: {
        kind: input.kind,
        caseDefinitionId: input.caseDefinitionId,
        caseId: input.ddtCaseId ?? null,
      },
    });
    return NextResponse.json(batch, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
