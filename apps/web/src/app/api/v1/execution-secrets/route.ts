import { createExecutionSecretInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "secret.manage");
    return NextResponse.json({ items: await services.executionSecrets.list(projectIds) });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createExecutionSecretInputSchema.parse(await readJsonBody(request, 32 * 1024));
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "secret.manage", input.projectId);
    const secret = await services.executionSecrets.create(input, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "execution_secret.create",
      resourceType: "execution_secret",
      resourceId: secret.id,
      projectId: secret.projectId,
      requestId: currentRequestId,
      details: { version: secret.currentVersion },
    });
    return NextResponse.json(secret, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
