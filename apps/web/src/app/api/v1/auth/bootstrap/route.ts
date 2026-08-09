import { bootstrapAdminInputSchema } from "@autoforge/contracts";
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
        `auth:bootstrap:v1:${clientAddress(request)}`,
        5,
        15 * 60_000,
      ),
    );
    const input = bootstrapAdminInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const session = await services.identityAccess.bootstrap(input, currentRequestId);
    const response = NextResponse.json({ userId: session.userId }, { status: 201 });
    response.cookies.set(sessionCookie(session.token, session.expiresAt));
    return response;
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
