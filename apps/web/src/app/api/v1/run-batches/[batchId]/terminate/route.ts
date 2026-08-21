import { cancelExecutionInputSchema } from "@autoforge/contracts";
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
    const input = cancelExecutionInputSchema.parse(await readJsonBody(request, 8 * 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.cancel");
    const batch = await services.runBatches.getSummary(batchId, projectIds);
    const cancelledRuns = await services.executionControl.terminateBatch(
      identity.user.id,
      batchId,
      input.reason,
    );
    const current = await services.runBatches.getSummary(batchId, projectIds);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "run_batch.terminate",
      resourceType: "run_batch",
      resourceId: batchId,
      projectId: batch.projectId,
      requestId: currentRequestId,
      details: { cancelledRuns, terminationRequestedAt: current.terminationRequestedAt ?? null },
    });
    return NextResponse.json({
      batchId,
      cancelledRuns,
      terminating: ["queued", "dispatching", "scheduled", "running"].includes(current.status),
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
