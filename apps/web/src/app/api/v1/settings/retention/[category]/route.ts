import { retentionCategorySchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ category: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const category = retentionCategorySchema.parse((await context.params).category);
    const services = await getPlatformServices();
    const policy = await services.platformOperations.updateRetentionPolicy(
      identity,
      category,
      await readJsonBody(request, 8 * 1024),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "retention_policy.update",
      resourceType: "retention_policy",
      resourceId: category,
      requestId: currentRequestId,
      details: { retentionDays: policy.retentionDays, revision: policy.revision },
    });
    return NextResponse.json(policy);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
