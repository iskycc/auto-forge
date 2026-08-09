import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    rejectRateLimited(await services.runnerRequestLimiter.allow("ldap:sync:v1", 2, 60_000));
    return NextResponse.json(
      await services.identityAccess.synchronizeLdap(identity, currentRequestId),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
