import { failureAnalysisClaimSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { readFailureAnalysisCompletion } from "@/lib/failure-analysis-upload";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { input, remarkImages } = await readFailureAnalysisCompletion(request);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "analysis.manage", input.projectId);
    const claims = await services.failureAnalysis.complete({
      projectId: input.projectId,
      analysisIds: input.analysisIds,
      ...(input.inheritedFromAnalysisId
        ? {
            inheritedFromAnalysisId: input.inheritedFromAnalysisId,
            inheritanceScope: input.inheritanceScope ?? "same_case",
          }
        : {}),
      category: input.category,
      claimant: { id: identity.user.id, username: identity.user.username },
      caseIssueConfirmed: input.caseIssueConfirmed,
      remarkImages,
      ...(input.issueDescription ? { issueDescription: input.issueDescription } : {}),
      ...(input.caseFixEvidence ? { caseFixEvidence: input.caseFixEvidence } : {}),
      ...(input.ticketReference ? { ticketReference: input.ticketReference } : {}),
      ...(input.remark ? { remark: input.remark } : {}),
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "failure_analysis.complete",
      resourceType: "failure_analysis",
      resourceId: claims[0]!.id,
      projectId: input.projectId,
      requestId: currentRequestId,
      details: {
        count: claims.length,
        category: input.category,
        ...(input.inheritedFromAnalysisId
          ? {
              inheritedFromAnalysisId: input.inheritedFromAnalysisId,
              inheritanceScope: input.inheritanceScope ?? "same_case",
            }
          : {}),
      },
    });
    return NextResponse.json({ items: failureAnalysisClaimSchema.array().parse(claims) });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
