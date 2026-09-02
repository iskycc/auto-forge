import {
  claimFailureAnalysisInputSchema,
  claimFailureAnalysisResultSchema,
  failureAnalysisClaimPageSchema,
  failureAnalysisSortSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  projectId: z.string().min(1),
  projectVersionId: z.string().min(1).optional(),
  batchId: z.string().min(1).optional(),
  sort: failureAnalysisSortSchema.default("class_path"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const identity = await authorizeRequest(request, "run.read", input.projectId);
    const services = await getPlatformServices();
    const page = await services.failureAnalysis.listMyClaims({
      projectId: input.projectId,
      claimantId: identity.user.id,
      sort: input.sort,
      direction: input.direction,
      limit: input.limit,
      ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return NextResponse.json(failureAnalysisClaimPageSchema.parse(page), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const body = await readJsonBody(request, 16 * 1024);
    const input = claimFailureAnalysisInputSchema.parse(body);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "analysis.manage", input.projectId);
    const result = await services.failureAnalysis.claim({
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      batchId: input.batchId,
      executionRunIds: input.executionRunIds,
      claimant: {
        id: identity.user.id,
        username: identity.user.username,
        displayName: identity.user.displayName,
      },
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "failure_analysis.claim",
      resourceType: "run_batch",
      resourceId: input.batchId,
      projectId: input.projectId,
      requestId: currentRequestId,
      details: { claimed: result.claimed.length, conflicts: result.conflicts.length },
    });
    return NextResponse.json(claimFailureAnalysisResultSchema.parse(result), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
