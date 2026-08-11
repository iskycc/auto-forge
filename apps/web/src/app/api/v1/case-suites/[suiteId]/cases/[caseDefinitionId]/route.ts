import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ suiteId: string; caseDefinitionId: string }> };

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_suite.manage");
    const { suiteId, caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    const suite = await services.caseSuites.removeCase(suiteId, caseDefinitionId, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.remove_case",
      resourceType: "case_suite",
      resourceId: suiteId,
      requestId: currentRequestId,
      details: { caseDefinitionId },
    });
    return NextResponse.json(suite);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
