import { refreshSessionResultSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { requestId, requireSameOrigin, sessionCookie, sessionTokenFromRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const sessionToken = sessionTokenFromRequest(request);
    if (!sessionToken) throw new DomainError("AUTH_REQUIRED", "请先登录。");
    const services = await getPlatformServices();
    const identity = await services.identityAccess.authenticateSession(sessionToken);
    const refreshed = await services.identityAccess.refreshSession(identity);
    const response = NextResponse.json(refreshSessionResultSchema.parse(refreshed), {
      headers: { "Cache-Control": "private, no-store" },
    });
    response.cookies.set(sessionCookie(sessionToken, refreshed.expiresAt, request));
    return response;
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
