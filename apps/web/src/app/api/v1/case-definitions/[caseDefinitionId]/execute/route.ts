import { NextResponse } from "next/server";
import { createSingleCaseRunInputSchema } from "@autoforge/contracts";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ caseDefinitionId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    const definition = await services.caseDefinitions.get(caseDefinitionId);
    services.identityAccess.authorize(identity, "run.create", definition.projectId);
    const input = createSingleCaseRunInputSchema.parse(await readJsonBody(request, 64 * 1024));
    const batch = await services.runBatches.createSingleCase(caseDefinitionId, {
      ...input,
      projectId: definition.projectId,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "execution.single_case_create",
      resourceType: "run_batch",
      resourceId: batch.id,
      projectId: definition.projectId,
      requestId: currentRequestId,
      details: {
        caseDefinitionId,
        runnerSelection: input.runnerGroupId ? "group" : "runners",
        adapterEnabled: input.adapter.enabled,
        delaySeconds: input.delaySeconds,
        scheduledFor: batch.scheduledFor,
      },
    });
    return NextResponse.json(batch, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
