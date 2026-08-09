import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ runnerId: string; leaseId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { runnerId, leaseId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`runner:lease:v1:${runnerId}`, 600, 60_000),
    );
    return NextResponse.json(
      await services.runnerProtocol.renewLease(
        runnerId,
        bearerToken(request),
        leaseId,
        await readJsonBody(request, 16 * 1024),
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
