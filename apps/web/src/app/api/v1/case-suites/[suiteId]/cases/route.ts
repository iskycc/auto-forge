import { updateCaseSuiteItemsInputSchema } from "@autoforge/contracts";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ suiteId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_suite.manage");
    const input = updateCaseSuiteItemsInputSchema.parse(await request.json());
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const suite = await services.caseSuites.addCases(
      suiteId,
      input.caseDefinitionIds,
      identity.user.id,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.add_cases",
      resourceType: "case_suite",
      resourceId: suiteId,
      requestId: currentRequestId,
      details: { caseCount: input.caseDefinitionIds.length },
    });
    return NextResponse.json(suite);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
