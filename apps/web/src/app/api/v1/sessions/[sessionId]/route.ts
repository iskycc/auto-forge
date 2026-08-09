import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ sessionId: string }> };

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { sessionId } = await context.params;
    await (
      await getPlatformServices()
    ).identityAccess.revokeManagedSession(identity, sessionId, currentRequestId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
