import { rerunFinalFailuresInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const input = rerunFinalFailuresInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.create");
    const source = await services.runBatches.getSummary(batchId, projectIds);
    services.identityAccess.authorize(identity, "run.create", source.projectId);
    const batch = await services.runBatches.rerunFinalFailures(batchId, input, {
      username: identity.user.username,
      source: identity.user.source,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "run_batch.rerun_final_failures",
      resourceType: "run_batch",
      resourceId: batch.id,
      projectId: batch.projectId,
      requestId: currentRequestId,
      details: {
        sourceBatchId: batchId,
        totalRuns: batch.totalRuns,
        concurrency: input.concurrency,
        enableRetryConcurrencyRules: input.enableRetryConcurrencyRules,
        enableRoundRecovery: input.enableRoundRecovery,
      },
    });
    return NextResponse.json(batch, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
