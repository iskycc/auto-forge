import { loginInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { clientAddress, requestId, requireSameOrigin, sessionCookie } from "@/lib/auth";
import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `auth:login:v1:${clientAddress(request)}`,
        10,
        15 * 60_000,
      ),
    );
    const input = loginInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const session = await services.identityAccess.login(input, currentRequestId);
    const response = NextResponse.json({ userId: session.userId });
    response.cookies.set(sessionCookie(session.token, session.expiresAt, request));
    return response;
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
