import { attemptEventQuerySchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { attemptId } = await context.params;
    const query = attemptEventQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    return NextResponse.json(
      await services.executionControl.listAttemptEvents({
        attemptId,
        limit: query.limit,
        ...(projectIds ? { projectIds } : {}),
        ...(query.afterEventId ? { afterEventId: query.afterEventId } : {}),
      }),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
