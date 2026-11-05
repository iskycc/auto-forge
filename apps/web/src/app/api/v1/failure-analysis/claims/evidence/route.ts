import {
  failureAnalysisClaimSchema,
  uploadFailureAnalysisEvidenceQuerySchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { readFailureAnalysisScreenshotBody } from "@/lib/failure-analysis-upload";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const input = uploadFailureAnalysisEvidenceQuerySchema.parse({
      projectId: url.searchParams.get("projectId"),
      analysisIds: url.searchParams.getAll("analysisId"),
      fileName: url.searchParams.get("fileName"),
    });
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "analysis.manage", input.projectId);
    const claims = await services.failureAnalysis.uploadScreenshot({
      projectId: input.projectId,
      analysisIds: input.analysisIds,
      claimantId: identity.user.id,
      fileName: input.fileName,
      mediaType: request.headers.get("content-type") ?? "application/octet-stream",
      content: await readFailureAnalysisScreenshotBody(request),
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "failure_analysis.evidence.upload",
      resourceType: "failure_analysis",
      resourceId: claims[0]!.id,
      projectId: input.projectId,
      requestId: currentRequestId,
      details: { count: claims.length, sizeBytes: claims[0]?.screenshot?.sizeBytes ?? 0 },
    });
    return NextResponse.json(
      { items: failureAnalysisClaimSchema.array().parse(claims) },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
