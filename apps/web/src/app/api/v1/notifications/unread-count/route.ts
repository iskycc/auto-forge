import { unreadNotificationCountSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const count = await (
      await getPlatformServices()
    ).platformOperations.countUnreadNotifications(identity);
    return NextResponse.json(unreadNotificationCountSchema.parse({ count }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
