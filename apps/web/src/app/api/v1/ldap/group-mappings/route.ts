import { ldapGroupMappingInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "ldap.read");
    return NextResponse.json(await services.identityAccess.listLdapGroupMappings(identity));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = ldapGroupMappingInputSchema.parse(await readJsonBody(request, 8 * 1024));
    await (
      await getPlatformServices()
    ).identityAccess.addLdapGroupMapping(identity, input, currentRequestId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
