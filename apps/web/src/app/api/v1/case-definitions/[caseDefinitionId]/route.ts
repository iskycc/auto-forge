import { updateCaseDefinitionInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ caseDefinitionId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "case.read");
    const { caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    return NextResponse.json(await services.caseDefinitions.get(caseDefinitionId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case.manage");
    const { caseDefinitionId } = await context.params;
    const input = updateCaseDefinitionInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    const definition = await services.caseDefinitions.update(
      caseDefinitionId,
      input,
      identity.user.id,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_definition.update",
      resourceType: "case_definition",
      resourceId: caseDefinitionId,
      requestId: currentRequestId,
      details: { revision: definition.revision },
    });
    return NextResponse.json(definition);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
