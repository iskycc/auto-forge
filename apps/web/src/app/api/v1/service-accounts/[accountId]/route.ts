import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ accountId: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { accountId } = await context.params;
    const services = await getPlatformServices();
    const account = await services.platformOperations.updateServiceAccount(
      identity,
      accountId,
      await readJsonBody(request, 64 * 1024),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "service_account.update",
      resourceType: "service_account",
      resourceId: accountId,
      requestId: currentRequestId,
      details: { status: account.status, revision: account.revision },
    });
    return NextResponse.json(account);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
