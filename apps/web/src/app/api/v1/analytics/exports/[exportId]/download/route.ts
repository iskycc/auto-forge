import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ exportId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { exportId } = await context.params;
    const services = await getPlatformServices();
    const result = await services.platformOperations.downloadAnalyticsExport(identity, exportId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "analytics.export.download",
      resourceType: "analytics_export",
      resourceId: exportId,
      requestId: currentRequestId,
      details: { sizeBytes: result.content.byteLength, sha256: result.job.sha256 ?? null },
    });
    return new NextResponse(Buffer.from(result.content), {
      headers: {
        "Content-Type": `${result.mediaType}; charset=utf-8`,
        "Content-Disposition": `attachment; filename="${result.job.fileName ?? `autoforge-analytics.${result.job.format}`}"`,
        "Content-Length": String(result.content.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
