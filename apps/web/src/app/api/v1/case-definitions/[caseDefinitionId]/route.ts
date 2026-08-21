import { updateCaseDefinitionInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ caseDefinitionId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case.read");
    return NextResponse.json(await services.caseDefinitions.get(caseDefinitionId, projectIds));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await context.params;
    const input = updateCaseDefinitionInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case.manage");
    const definition = await services.caseDefinitions.update(
      caseDefinitionId,
      input,
      identity.user.id,
      projectIds,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_definition.update",
      resourceType: "case_definition",
      resourceId: caseDefinitionId,
      projectId: definition.projectId,
      requestId: currentRequestId,
      details: { revision: definition.revision },
    });
    return NextResponse.json(definition);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case.manage");
    const [deleted] = await services.caseDefinitions.deleteMany([caseDefinitionId], projectIds);
    if (!deleted) throw new Error("Deleted case definition result is missing.");
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_definition.delete",
      resourceType: "case_definition",
      resourceId: deleted.id,
      projectId: deleted.projectId,
      requestId: currentRequestId,
      details: { displayName: deleted.displayName },
    });
    return NextResponse.json({ deletedCount: 1 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
