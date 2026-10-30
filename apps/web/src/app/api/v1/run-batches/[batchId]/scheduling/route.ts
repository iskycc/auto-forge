import { batchSchedulingControlSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };
export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const { action } = batchSchedulingControlSchema.parse(await readJsonBody(request, 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.cancel");
    const batch = await services.runBatches.getSummary(batchId, projectIds);
    const changed = await services.executionControl.changeBatchScheduling(
      identity.user.id,
      batchId,
      action,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: `run_batch.${action}`,
      resourceType: "run_batch",
      resourceId: batchId,
      projectId: batch.projectId,
      requestId: currentRequestId,
      details: { changed },
    });
    return NextResponse.json({ batchId, action, changed });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
