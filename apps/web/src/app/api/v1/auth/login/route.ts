import { loginInputSchema } from "@autoforge/contracts";
import { isDomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { clientAddress, requestId, requireSameOrigin, sessionCookie } from "@/lib/auth";
import {
  apiErrorResponse,
  logServerError,
  readJsonBody,
  rejectRateLimited,
} from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `auth:login:v1:${clientAddress(request)}`,
        services.config.authLoginAttemptsPerWindow,
        15 * 60_000,
      ),
    );
    const input = loginInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const session = await services.identityAccess.login(input, currentRequestId);
    const response = NextResponse.json({ userId: session.userId });
    response.cookies.set(
      sessionCookie(session.token, session.expiresAt, request, services.clock.now()),
    );
    return response;
  } catch (error) {
    if (
      isDomainError(error) &&
      error.cause !== undefined &&
      ["LDAP_CONFIGURATION_INVALID", "LDAP_LOGIN_FINALIZATION_FAILED"].includes(error.code)
    ) {
      logServerError(error.cause, currentRequestId, "LDAP login persistence failed");
    }
    return apiErrorResponse(error, currentRequestId);
  }
}
