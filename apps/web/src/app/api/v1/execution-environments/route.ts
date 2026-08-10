import { createExecutionEnvironmentInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "environment.read");
    return NextResponse.json({ items: await services.executionEnvironments.list(projectIds) });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createExecutionEnvironmentInputSchema.parse(
      await readJsonBody(request, 64 * 1024),
    );
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "environment.manage", input.projectId);
    const environment = await services.executionEnvironments.create(input, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "execution_environment.create",
      resourceType: "execution_environment",
      resourceId: environment.id,
      projectId: environment.projectId,
      requestId: currentRequestId,
      details: {
        version: environment.currentVersion,
        variableCount: environment.current.variables.length,
      },
    });
    return NextResponse.json(environment, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
