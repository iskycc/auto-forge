import { changePasswordInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import {
  authenticateRequest,
  expiredSessionCookie,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function PUT(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = changePasswordInputSchema.parse(await readJsonBody(request, 16 * 1024));
    await (
      await getPlatformServices()
    ).identityAccess.changePassword(
      identity,
      input.currentPassword,
      input.newPassword,
      currentRequestId,
    );
    const response = new NextResponse(null, { status: 204 });
    response.cookies.set(expiredSessionCookie());
    return response;
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
