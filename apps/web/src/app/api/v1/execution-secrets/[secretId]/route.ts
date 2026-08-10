import { rotateExecutionSecretInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ secretId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { secretId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "secret.manage");
    return NextResponse.json(await services.executionSecrets.get(secretId, projectIds));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { secretId } = await context.params;
    const input = rotateExecutionSecretInputSchema.parse(await readJsonBody(request, 32 * 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "secret.manage");
    const current = await services.executionSecrets.get(secretId, projectIds);
    const secret = await services.executionSecrets.rotate(secretId, input, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "execution_secret.rotate",
      resourceType: "execution_secret",
      resourceId: secret.id,
      projectId: current.projectId,
      requestId: currentRequestId,
      details: { version: secret.currentVersion },
    });
    return NextResponse.json(secret);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
