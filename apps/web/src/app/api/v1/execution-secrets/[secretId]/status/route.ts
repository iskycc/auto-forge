import { setExecutionSecretStatusInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ secretId: string }> };

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { secretId } = await context.params;
    const input = setExecutionSecretStatusInputSchema.parse(await readJsonBody(request, 8 * 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "secret.manage");
    const current = await services.executionSecrets.get(secretId, projectIds);
    const secret = await services.executionSecrets.setStatus(secretId, input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: input.status === "disabled" ? "execution_secret.disable" : "execution_secret.enable",
      resourceType: "execution_secret",
      resourceId: secret.id,
      projectId: current.projectId,
      requestId: currentRequestId,
      details: { status: input.status },
    });
    return NextResponse.json(secret);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
