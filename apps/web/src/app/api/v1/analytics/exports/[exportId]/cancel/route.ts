import { analyticsExportJobSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ exportId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { exportId } = await context.params;
    const services = await getPlatformServices();
    const job = await services.platformOperations.cancelAnalyticsExport(identity, exportId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "analytics.export.cancel",
      resourceType: "analytics_export",
      resourceId: exportId,
      requestId: currentRequestId,
      details: { status: job.status },
    });
    return NextResponse.json(analyticsExportJobSchema.parse(job));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
