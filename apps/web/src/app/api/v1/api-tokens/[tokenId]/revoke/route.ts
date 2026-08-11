import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ tokenId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { tokenId } = await context.params;
    const services = await getPlatformServices();
    const token = await services.platformOperations.revokeApiToken(identity, tokenId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "api_token.revoke",
      resourceType: "api_token",
      resourceId: tokenId,
      requestId: currentRequestId,
      details: { serviceAccountId: token.serviceAccountId },
    });
    return NextResponse.json(token);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
