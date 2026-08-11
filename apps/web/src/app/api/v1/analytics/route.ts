import { analyticsFilterSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, rejectRateLimited } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const filter = analyticsFilterSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`analytics:v1:${identity.user.id}`, 60, 60_000),
    );
    return NextResponse.json(await services.platformOperations.analytics(identity, filter), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
