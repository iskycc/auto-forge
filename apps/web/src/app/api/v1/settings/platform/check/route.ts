import { platformInfrastructureCheckSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authorizeRequest, clientAddress, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    await authorizeRequest(request, "settings.manage", undefined);
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `settings:platform-check:v1:${clientAddress(request)}`,
        30,
        15 * 60_000,
      ),
    );
    const target = platformInfrastructureCheckSchema.parse(await readJsonBody(request, 24 * 1024));
    return NextResponse.json(await services.infrastructureCheck(target), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (cause) {
    return apiErrorResponse(cause, currentRequestId);
  }
}
