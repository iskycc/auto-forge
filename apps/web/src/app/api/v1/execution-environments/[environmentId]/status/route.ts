import { setExecutionEnvironmentStatusInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ environmentId: string }> };

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { environmentId } = await context.params;
    const input = setExecutionEnvironmentStatusInputSchema.parse(
      await readJsonBody(request, 8 * 1024),
    );
    const services = await getPlatformServices();
    const manageableProjects = services.identityAccess.projectScope(identity, "environment.manage");
    const current = await services.executionEnvironments.get(environmentId, manageableProjects);
    const environment = await services.executionEnvironments.setStatus(environmentId, input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action:
        input.status === "disabled"
          ? "execution_environment.disable"
          : "execution_environment.enable",
      resourceType: "execution_environment",
      resourceId: environment.id,
      projectId: current.projectId,
      requestId: currentRequestId,
      details: { status: input.status },
    });
    return NextResponse.json(environment);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
