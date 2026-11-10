import { setCaseSuiteLockInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function PUT(request: Request, context: { params: Promise<{ suiteId: string }> }) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = setCaseSuiteLockInputSchema.parse(await readJsonBody(request, 1024));
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const suite = await services.caseSuites.setLock(suiteId, input, identity.user, projectIds);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: input.locked ? "case_suite.lock" : "case_suite.unlock",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: { revision: suite.revision },
    });
    return NextResponse.json(suite);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
