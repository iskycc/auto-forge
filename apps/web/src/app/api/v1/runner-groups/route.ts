import { createRunnerGroupInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "runner.read");
    return NextResponse.json({ items: await services.runnerGroups.list() });
  } catch (error) {
    return apiErrorResponse(error, requestId(request));
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "runner.manage");
    const group = await services.runnerGroups.create(
      createRunnerGroupInputSchema.parse(await readJsonBody(request, 64 * 1024)),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner_group.create",
      resourceType: "runner_group",
      resourceId: group.id,
      requestId: currentRequestId,
      details: { memberCount: group.runnerIds.length },
    });
    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
