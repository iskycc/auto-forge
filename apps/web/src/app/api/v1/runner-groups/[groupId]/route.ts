import { updateRunnerGroupInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ groupId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "runner.read");
    return NextResponse.json(await services.runnerGroups.get((await context.params).groupId));
  } catch (error) {
    return apiErrorResponse(error, requestId(request));
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "runner.manage");
    const group = await services.runnerGroups.update(
      (await context.params).groupId,
      updateRunnerGroupInputSchema.parse(await readJsonBody(request, 64 * 1024)),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner_group.update",
      resourceType: "runner_group",
      resourceId: group.id,
      requestId: currentRequestId,
      details: { memberCount: group.runnerIds.length, revision: group.revision },
    });
    return NextResponse.json(group);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "runner.manage");
    const groupId = (await context.params).groupId;
    await services.runnerGroups.delete(groupId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner_group.delete",
      resourceType: "runner_group",
      resourceId: groupId,
      requestId: currentRequestId,
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
