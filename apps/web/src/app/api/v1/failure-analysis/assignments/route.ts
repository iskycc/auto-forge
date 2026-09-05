import {
  claimFailureAnalysisInputSchema,
  claimFailureAnalysisResultSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const inputSchema = claimFailureAnalysisInputSchema.extend({ assigneeId: z.string().min(1) });

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const input = inputSchema.parse(await readJsonBody(request, 16 * 1024));
    const identity = await authorizeRequest(request, "analysis.assign", input.projectId);
    const services = await getPlatformServices();
    const claimant = await services.identityAccess.requireAnalysisAssignee(
      identity,
      input.projectId,
      input.assigneeId,
    );
    const result = await services.failureAnalysis.claim({ ...input, claimant });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "failure_analysis.assigned",
      resourceType: "run_batch",
      resourceId: input.batchId,
      projectId: input.projectId,
      requestId: currentRequestId,
      details: {
        assigneeId: claimant.id,
        assigned: result.claimed.length,
        conflicts: result.conflicts.length,
      },
    });
    return NextResponse.json(claimFailureAnalysisResultSchema.parse(result), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
