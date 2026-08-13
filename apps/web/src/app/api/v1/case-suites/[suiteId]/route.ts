import { updateCaseSuiteInputSchema } from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ suiteId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.read");
    const { suiteId } = await context.params;
    return NextResponse.json(await services.caseSuites.get(suiteId, projectIds));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { suiteId } = await context.params;
    const input = updateCaseSuiteInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const suite = await services.caseSuites.update(suiteId, input, identity.user.id, projectIds);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.update",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: { revision: suite.revision, version: suite.version },
    });
    return NextResponse.json(suite);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
