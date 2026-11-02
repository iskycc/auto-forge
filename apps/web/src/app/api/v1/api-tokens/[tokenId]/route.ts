import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requireSameOrigin, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
export async function DELETE(request: Request, context: { params: Promise<{ tokenId: string }> }) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { tokenId } = await context.params;
    const services = await getPlatformServices();
    const deleted = await services.platformOperations.deleteApiToken(identity, tokenId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "api_token.delete",
      resourceType: "api_token",
      resourceId: tokenId,
      requestId: currentRequestId,
      details: { name: deleted.name, serviceAccountId: deleted.serviceAccountId },
    });
    return NextResponse.json(deleted);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
