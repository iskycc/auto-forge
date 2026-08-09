import { ldapConfigurationInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const services = await getPlatformServices();
    const identity = await authenticateRequest(request);
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`ldap:test:v1:${identity.user.id}`, 5, 60_000),
    );
    const input = ldapConfigurationInputSchema.parse(await readJsonBody(request, 192 * 1024));
    await services.identityAccess.testLdapConfiguration(identity, input, currentRequestId);
    return NextResponse.json({ connected: true });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
