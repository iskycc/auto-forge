import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ accountId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { accountId } = await context.params;
    return NextResponse.json({
      items: await (
        await getPlatformServices()
      ).platformOperations.listApiTokens(identity, accountId),
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { accountId } = await context.params;
    const services = await getPlatformServices();
    const issued = await services.platformOperations.issueApiToken(
      identity,
      accountId,
      await readJsonBody(request, 32 * 1024),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "api_token.issue",
      resourceType: "api_token",
      resourceId: issued.id,
      requestId: currentRequestId,
      details: { serviceAccountId: accountId, prefix: issued.prefix, expiresAt: issued.expiresAt },
    });
    return NextResponse.json(issued, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
