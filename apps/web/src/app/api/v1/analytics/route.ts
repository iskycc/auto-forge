import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { readReadyModel } from "@/lib/read-ready-model";
import { analyticsFilterSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, rejectRateLimited } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const filter = analyticsFilterSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const services = await getPlatformServices();
    const timeZone = services.configurationStore.read().web.timeZone;
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`analytics:v1:${identity.user.id}`, 60, 60_000),
    );
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    if (filter.projectId) services.identityAccess.authorize(identity, "run.read", filter.projectId);
    return NextResponse.json(
      await readReadyModel(
        services.readModels,
        {
          kind: "analytics_scope",
          projectId: filter.projectId ?? DEFAULT_PROJECT_ID,
          ...(projectIds ? { projectIds: [...projectIds].sort() } : {}),
          filter: { ...filter, timeZone },
        },
        request.signal,
      ),
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
