import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    return NextResponse.json({
      items: await (await getPlatformServices()).platformOperations.listServiceAccounts(identity),
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
    const account = await services.platformOperations.createServiceAccount(
      identity,
      await readJsonBody(request, 64 * 1024),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "service_account.create",
      resourceType: "service_account",
      resourceId: account.id,
      requestId: currentRequestId,
    });
    return NextResponse.json(account, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
