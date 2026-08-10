import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ userId: string }> };

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { userId } = await context.params;
    await (
      await getPlatformServices()
    ).identityAccess.revokeUserSessions(identity, userId, currentRequestId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
