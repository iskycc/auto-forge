import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "settings.read");
    const services = await getPlatformServices();
    const diagnostic = await services.diagnostics.read(
      new URL(request.url).searchParams.get("refresh") === "1",
    );
    const generatedAt = diagnostic.generatedAt;
    const download = new URL(request.url).searchParams.get("download") === "1";
    return NextResponse.json(diagnostic, {
      headers: {
        "Cache-Control": "private, no-store",
        ...(download
          ? {
              "Content-Disposition": `attachment; filename="autoforge-diagnostics-${generatedAt.slice(0, 10)}.json"`,
              "X-Content-Type-Options": "nosniff",
            }
          : {}),
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage");
    const services = await getPlatformServices();
    const redriven = await services.jobQueue.redriveDeadLetters({
      redrivenAt: services.clock.now().toISOString(),
      limit: 100,
    });
    await services.identityAccess.recordQueueDeadLetterRedrive(
      identity,
      { redriven },
      currentRequestId,
    );
    return NextResponse.json({ redriven });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
