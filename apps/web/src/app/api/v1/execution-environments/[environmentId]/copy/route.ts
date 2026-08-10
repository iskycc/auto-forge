import { copyExecutionEnvironmentInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ environmentId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { environmentId } = await context.params;
    const input = copyExecutionEnvironmentInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "environment.manage");
    const copied = await services.executionEnvironments.copy(
      environmentId,
      input,
      identity.user.id,
      projectIds,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "execution_environment.copy",
      resourceType: "execution_environment",
      resourceId: copied.id,
      projectId: copied.projectId,
      requestId: currentRequestId,
      details: {
        sourceEnvironmentId: environmentId,
        variableCount: copied.current.variables.length,
        secretBindingCount: copied.current.secretBindings.length,
      },
    });
    return NextResponse.json(copied, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
