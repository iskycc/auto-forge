import { updateRunnerLifecycleInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ runnerId: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "runner.manage");
    const { runnerId } = await context.params;
    const input = updateRunnerLifecycleInputSchema.parse(await readJsonBody(request, 4 * 1024));
    const services = await getPlatformServices();
    const runner = await services.runnerControl.setLifecycleState(runnerId, input.state);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.lifecycle_update",
      resourceType: "runner",
      resourceId: runnerId,
      requestId: currentRequestId,
      details: { state: input.state },
    });
    return NextResponse.json(runner);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
