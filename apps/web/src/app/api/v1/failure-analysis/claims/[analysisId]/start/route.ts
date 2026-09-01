import { failureAnalysisClaimSchema, startFailureAnalysisInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ analysisId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const body = await readJsonBody(request, 8 * 1024);
    const projectId = z.object({ projectId: z.string().min(1) }).parse(body).projectId;
    const input = startFailureAnalysisInputSchema.parse(body);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "analysis.manage", projectId);
    const analysisId = (await context.params).analysisId;
    const claim = await services.failureAnalysis.start({
      analysisId,
      projectId,
      claimantId: identity.user.id,
      category: input.category,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "failure_analysis.start",
      resourceType: "failure_analysis",
      resourceId: analysisId,
      projectId,
      requestId: currentRequestId,
      details: { category: input.category },
    });
    return NextResponse.json(failureAnalysisClaimSchema.parse(claim));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
