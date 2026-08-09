import { createRunBatchInputSchema } from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "run.read");
    const url = new URL(request.url);
    const { limit } = querySchema.parse({ limit: url.searchParams.get("limit") ?? undefined });
    const services = await getPlatformServices();
    return NextResponse.json({ items: await services.runBatches.list(limit) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "run.create");
    const input = createRunBatchInputSchema.parse(await readJsonBody(request, 128 * 1024));
    const services = await getPlatformServices();
    const batch = await services.runBatches.create(input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "run_batch.create",
      resourceType: "run_batch",
      resourceId: batch.id,
      requestId: currentRequestId,
      details: { totalRuns: batch.totalRuns, retryLimit: batch.retryLimit },
    });
    return NextResponse.json(batch, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
