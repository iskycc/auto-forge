import { updateCaseSuiteItemsInputSchema } from "@autoforge/contracts";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ suiteId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = updateCaseSuiteItemsInputSchema.parse(await request.json());
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const suite = await services.caseSuites.addCases(
      suiteId,
      input.caseDefinitionIds,
      identity.user.id,
      projectIds,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.add_cases",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: { caseCount: input.caseDefinitionIds.length },
    });
    return NextResponse.json(suite);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = updateCaseSuiteItemsInputSchema.parse(await request.json());
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const suite = await services.caseSuites.removeCases(
      suiteId,
      input.caseDefinitionIds,
      identity.user.id,
      projectIds,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.remove_cases",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: { caseCount: input.caseDefinitionIds.length },
    });
    return NextResponse.json(suite);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
