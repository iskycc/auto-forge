import { registerUserInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { clientAddress, requestId, requireSameOrigin, sessionCookie } from "@/lib/auth";
import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(
      await (await getPlatformServices()).identityAccess.registrationAvailability(),
      {
        headers: { "cache-control": "private, no-store" },
      },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `auth:register:v1:${clientAddress(request)}`,
        10,
        15 * 60_000,
      ),
    );
    const input = registerUserInputSchema.parse(await readJsonBody(request, 8192));
    const session = await services.identityAccess.register(input, currentRequestId);
    const response = NextResponse.json(
      { userId: session.userId },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
    response.cookies.set(
      sessionCookie(session.token, session.expiresAt, request, services.clock.now()),
    );
    return response;
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
