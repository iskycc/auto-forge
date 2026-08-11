import { analyticsExportJobSchema, createAnalyticsExportInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `analytics-export:v1:${identity.user.id}`,
        10,
        60_000,
      ),
    );
    const input = createAnalyticsExportInputSchema.parse(await readJsonBody(request, 32 * 1024));
    const job = await services.platformOperations.enqueueAnalyticsExport(
      identity,
      input,
      request.headers.get("idempotency-key")?.trim() || currentRequestId,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "analytics.export.request",
      resourceType: "analytics_export",
      resourceId: job.id,
      requestId: currentRequestId,
      details: { format: job.format, filter: JSON.stringify(job.filter) },
    });
    return NextResponse.json(analyticsExportJobSchema.parse(job), { status: 202 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
