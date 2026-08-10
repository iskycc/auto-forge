import { createRunBatchInputSchema } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const { limit } = querySchema.parse({ limit: url.searchParams.get("limit") ?? undefined });
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    return NextResponse.json({ items: await services.runBatches.list(limit, projectIds) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createRunBatchInputSchema.parse(await readJsonBody(request, 128 * 1024));
    const services = await getPlatformServices();
    const projectScope = services.identityAccess.projectScope(identity, "run.create");
    const projectId = input.projectId ?? projectScope?.at(0) ?? DEFAULT_PROJECT_ID;
    services.identityAccess.authorize(identity, "run.create", projectId);
    if (input.environmentVersionId) {
      services.identityAccess.authorize(identity, "environment.read", projectId);
    }
    const batch = await services.runBatches.create({ ...input, projectId });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "run_batch.create",
      resourceType: "run_batch",
      resourceId: batch.id,
      projectId: batch.projectId,
      requestId: currentRequestId,
      details: { totalRuns: batch.totalRuns, retryLimit: batch.retryLimit },
    });
    return NextResponse.json(batch, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
