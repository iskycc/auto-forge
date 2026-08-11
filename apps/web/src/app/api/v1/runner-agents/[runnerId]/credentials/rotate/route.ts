import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ runnerId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { runnerId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:credentials:rotate:v1:${runnerId}`,
        10,
        60_000,
      ),
    );
    const rotation = await services.runnerControl.rotateCredential(runnerId, bearerToken(request));
    return NextResponse.json(rotation);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
