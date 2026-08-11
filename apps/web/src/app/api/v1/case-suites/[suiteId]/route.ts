import { updateCaseSuiteInputSchema } from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ suiteId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "case_suite.read");
    const { suiteId } = await context.params;
    return NextResponse.json(await (await getPlatformServices()).caseSuites.get(suiteId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_suite.manage");
    const { suiteId } = await context.params;
    const input = updateCaseSuiteInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    const suite = await services.caseSuites.update(suiteId, input, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.update",
      resourceType: "case_suite",
      resourceId: suiteId,
      requestId: currentRequestId,
      details: { revision: suite.revision, version: suite.version },
    });
    return NextResponse.json(suite);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
