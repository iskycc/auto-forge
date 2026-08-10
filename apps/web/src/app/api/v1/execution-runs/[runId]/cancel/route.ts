import { cancelExecutionInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { runId } = await context.params;
    const input = cancelExecutionInputSchema.parse(await readJsonBody(request, 8 * 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.cancel");
    await services.executionControl.cancelRun(identity.user.id, runId, input.reason, projectIds);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "execution_run.cancel",
      resourceType: "execution_run",
      resourceId: runId,
      requestId: currentRequestId,
    });
    return NextResponse.json({ runId, cancelled: true });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
