import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    return NextResponse.json({
      items: await (await getPlatformServices()).platformOperations.listLdapSyncJobs(identity),
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    rejectRateLimited(await services.runnerRequestLimiter.allow("ldap:sync:v1", 2, 60_000));
    return NextResponse.json(
      await services.platformOperations.runLdapSynchronization(identity, () =>
        services.identityAccess.synchronizeLdap(identity, currentRequestId),
      ),
      { status: 202 },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
