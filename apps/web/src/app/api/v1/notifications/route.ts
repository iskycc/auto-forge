import { notificationListQuerySchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const query = notificationListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).platformOperations.listNotifications(identity, {
        unreadOnly: query.unreadOnly,
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      }),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
