import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ runnerId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { runnerId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`runner:reconcile:v1:${runnerId}`, 30, 60_000),
    );
    return NextResponse.json(
      await services.runnerProtocol.reconcile(
        runnerId,
        bearerToken(request),
        await readJsonBody(request, 128 * 1024),
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
