import {
  executeRetentionInputSchema,
  retentionCategorySchema,
  retentionExecutionResultSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ category: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const category = retentionCategorySchema.parse((await context.params).category);
    const input = executeRetentionInputSchema.parse(await readJsonBody(request, 8 * 1024));
    const services = await getPlatformServices();
    const result = retentionExecutionResultSchema.parse(
      await services.platformOperations.executeRetentionNow(identity, category, input),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "retention.execute",
      resourceType: "retention_policy",
      resourceId: category,
      requestId: currentRequestId,
      details: result,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
