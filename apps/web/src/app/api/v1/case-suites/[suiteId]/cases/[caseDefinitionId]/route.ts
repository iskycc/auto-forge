import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ suiteId: string; caseDefinitionId: string }> };

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { suiteId, caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const suite = await services.caseSuites.removeCase(
      suiteId,
      caseDefinitionId,
      identity.user.id,
      projectIds,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.remove_case",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: { caseDefinitionId },
    });
    return NextResponse.json(suite);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
