import { createRoleInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    return NextResponse.json(
      await (await getPlatformServices()).identityAccess.listRoles(identity),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createRoleInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const role = await (
      await getPlatformServices()
    ).identityAccess.createRole(identity, input, currentRequestId);
    return NextResponse.json(role, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
