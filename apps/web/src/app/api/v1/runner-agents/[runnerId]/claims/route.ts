import { RUNNER_CLAIM_BODY_LIMIT_BYTES } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ runnerId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { runnerId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:claim:v1:${runnerId}`,
        services.config.runnerClaimRateLimitPerMinute,
        60_000,
      ),
    );
    const response = await services.runnerProtocol.claim(
      runnerId,
      bearerToken(request),
      await readJsonBody(request, RUNNER_CLAIM_BODY_LIMIT_BYTES),
    );
    return NextResponse.json(response);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
