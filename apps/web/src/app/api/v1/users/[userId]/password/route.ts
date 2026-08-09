import { resetUserPasswordInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ userId: string }> };

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { userId } = await context.params;
    const input = resetUserPasswordInputSchema.parse(await readJsonBody(request, 8 * 1024));
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.resetPassword(
        identity,
        userId,
        input.password,
        input.forcePasswordChange,
        currentRequestId,
      ),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
