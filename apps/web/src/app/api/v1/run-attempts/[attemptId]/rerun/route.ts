import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    const rerunContext = await services.runBatches.getAttemptRerunContext(attemptId);
    services.identityAccess.authorize(identity, "log.read", rerunContext.projectId);
    services.identityAccess.authorize(identity, "run.create", rerunContext.projectId);
    const batch = await services.runBatches.rerunCaseFromAttempt(attemptId, {
      username: identity.user.username,
      source: identity.user.source,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "run_attempt.rerun",
      resourceType: "run_attempt",
      resourceId: attemptId,
      projectId: rerunContext.projectId,
      requestId: currentRequestId,
      details: { diagnosticBatchId: batch.id },
    });
    return NextResponse.json({ batchId: batch.id }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
