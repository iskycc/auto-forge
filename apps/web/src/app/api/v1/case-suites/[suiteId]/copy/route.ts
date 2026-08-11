import { copyCaseSuiteInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_suite.manage");
    const { suiteId } = await context.params;
    const input = copyCaseSuiteInputSchema.parse(await readJsonBody(request, 4 * 1024));
    const services = await getPlatformServices();
    const suite = await services.caseSuites.copy(suiteId, input, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.copy",
      resourceType: "case_suite",
      resourceId: suite.id,
      requestId: currentRequestId,
      details: { sourceSuiteId: suiteId, caseCount: suite.caseCount },
    });
    return NextResponse.json(suite, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
