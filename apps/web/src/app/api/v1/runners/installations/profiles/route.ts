import { runnerInstallationProfileListSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "runner.manage");
    const services = await getPlatformServices();
    const runners = await services.runnerControl.list(500);
    await services.runnerInstallationProfiles.reconcileBindings(runners);
    return NextResponse.json(
      runnerInstallationProfileListSchema.parse({
        items: await services.runnerInstallationProfiles.list(),
      }),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
