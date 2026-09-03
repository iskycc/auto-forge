import {
  failureAnalysisRerunProofLookupResultSchema,
  lookupFailureAnalysisRerunProofsInputSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = lookupFailureAnalysisRerunProofsInputSchema.parse(
      await readJsonBody(request, 32 * 1024),
    );
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "analysis.manage", input.projectId);
    const items = await services.failureAnalysis.lookupRerunProofs({
      projectId: input.projectId,
      analysisIds: input.analysisIds,
      claimantId: identity.user.id,
    });
    return NextResponse.json(failureAnalysisRerunProofLookupResultSchema.parse({ items }));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
