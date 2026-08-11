import { publicPlatformStatisticsSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { clientAddress, requestId } from "@/lib/auth";
import { apiErrorResponse, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `public-statistics:v1:${clientAddress(request)}`,
        120,
        60_000,
      ),
    );
    const statistics = publicPlatformStatisticsSchema.parse(await services.publicStatistics.read());
    return NextResponse.json(statistics, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
