import { NextResponse } from "next/server";

import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ runnerId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "runner.manage");
    const { runnerId } = await context.params;
    const services = await getPlatformServices();
    const runner = await services.runnerControl.revokeCredential(runnerId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.credential_revoke",
      resourceType: "runner",
      resourceId: runnerId,
      requestId: currentRequestId,
      details: { credentialVersion: runner.credentialVersion },
    });
    return NextResponse.json(runner);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
