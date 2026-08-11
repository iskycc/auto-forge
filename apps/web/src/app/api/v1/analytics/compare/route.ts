import { analyticsBatchComparisonSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  leftBatchId: z.string().min(1).max(128),
  rightBatchId: z.string().min(1).max(128),
});

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const comparison = await services.platformOperations.compareBatches(
      identity,
      query.leftBatchId,
      query.rightBatchId,
    );
    return NextResponse.json(analyticsBatchComparisonSchema.parse(comparison));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
