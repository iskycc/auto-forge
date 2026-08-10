import { updateExecutionEnvironmentInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ environmentId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { environmentId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "environment.read");
    return NextResponse.json(await services.executionEnvironments.get(environmentId, projectIds));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { environmentId } = await context.params;
    const input = updateExecutionEnvironmentInputSchema.parse(
      await readJsonBody(request, 64 * 1024),
    );
    const services = await getPlatformServices();
    const manageableProjects = services.identityAccess.projectScope(identity, "environment.manage");
    const current = await services.executionEnvironments.get(environmentId, manageableProjects);
    const environment = await services.executionEnvironments.update(
      environmentId,
      input,
      identity.user.id,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "execution_environment.update",
      resourceType: "execution_environment",
      resourceId: environment.id,
      projectId: current.projectId,
      requestId: currentRequestId,
      details: {
        versionCreated: input.variables !== undefined || input.secretBindings !== undefined,
        currentVersion: environment.currentVersion,
        metadataChanged: input.name !== undefined || input.description !== undefined,
        variableCount: environment.current.variables.length,
        secretBindingCount: environment.current.secretBindings.length,
      },
    });
    return NextResponse.json(environment);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
