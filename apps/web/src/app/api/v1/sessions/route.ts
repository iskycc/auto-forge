import { sessionListQuerySchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request, { allowPasswordChangeRequired: true });
    const input = sessionListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.listSessions(identity, input.userId ?? identity.user.id),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
