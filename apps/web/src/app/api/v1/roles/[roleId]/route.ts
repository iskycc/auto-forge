import { updateRoleInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ roleId: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { roleId } = await context.params;
    const input = updateRoleInputSchema.parse(await readJsonBody(request, 16 * 1024));
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.updateRole(identity, roleId, input, currentRequestId),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { roleId } = await context.params;
    await (
      await getPlatformServices()
    ).identityAccess.deleteRole(identity, roleId, currentRequestId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
