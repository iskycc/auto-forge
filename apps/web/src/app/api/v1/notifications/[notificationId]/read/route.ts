import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ notificationId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { notificationId } = await context.params;
    await (
      await getPlatformServices()
    ).platformOperations.markNotificationRead(identity, notificationId);
    return NextResponse.json({ read: true });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
