import { NextResponse } from "next/server";

import {
  authenticateRequest,
  expiredSessionCookie,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    await (await getPlatformServices()).identityAccess.logout(identity, currentRequestId);
    const response = new NextResponse(null, { status: 204 });
    response.cookies.set(expiredSessionCookie(request));
    return response;
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
