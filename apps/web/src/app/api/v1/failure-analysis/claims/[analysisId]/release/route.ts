import {
  failureAnalysisClaimReleaseSchema,
  releaseFailureAnalysisClaimInputSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ analysisId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = releaseFailureAnalysisClaimInputSchema.parse(
      await readJsonBody(request, 8 * 1024),
    );
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "analysis.manage", input.projectId);
    const released = await services.failureAnalysis.releaseClaim({
      analysisId: (await context.params).analysisId,
      projectId: input.projectId,
      claimantId: identity.user.id,
      reason: input.reason,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "failure_analysis.claim.release",
      resourceType: "failure_analysis",
      resourceId: released.analysisId,
      projectId: released.projectId,
      requestId: currentRequestId,
      details: {
        batchId: released.batchId,
        executionRunId: released.executionRunId,
        reason: released.reason,
      },
    });
    return NextResponse.json(failureAnalysisClaimReleaseSchema.parse(released));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
