import { updateUserStatusInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ userId: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { userId } = await context.params;
    const input = updateUserStatusInputSchema.parse(await readJsonBody(request, 4 * 1024));
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.updateUserStatus(identity, userId, input.status, currentRequestId),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
