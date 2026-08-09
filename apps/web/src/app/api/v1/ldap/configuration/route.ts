import { ldapConfigurationInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    return NextResponse.json(
      await (await getPlatformServices()).identityAccess.getLdapConfiguration(identity),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = ldapConfigurationInputSchema.parse(await readJsonBody(request, 192 * 1024));
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.saveLdapConfiguration(identity, input, currentRequestId),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
