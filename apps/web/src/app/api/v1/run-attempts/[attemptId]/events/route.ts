import { attemptEventQuerySchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeAttemptRead } from "@/lib/execution-public-access";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { attemptId } = await context.params;
    const query = attemptEventQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const services = await getPlatformServices();
    const { projectIds, shared } = await authorizeAttemptRead(
      request,
      attemptId,
      "run.read",
      services,
    );
    const page = await services.executionControl.listAttemptEvents({
      attemptId,
      limit: query.limit,
      ...(projectIds ? { projectIds } : {}),
      ...(query.afterEventId ? { afterEventId: query.afterEventId } : {}),
    });
    return NextResponse.json(
      shared
        ? {
            ...page,
            items: page.items.map(
              ({ eventId, eventType, fromStatus, toStatus, reasonCode, recordedAt }) => ({
                eventId,
                eventType,
                fromStatus,
                toStatus,
                reasonCode,
                recordedAt,
              }),
            ),
          }
        : page,
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
