import { checkBootstrapInfrastructureInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { clientAddress, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `auth:setup-platform-check:v1:${clientAddress(request)}`,
        30,
        15 * 60_000,
      ),
    );
    const input = checkBootstrapInfrastructureInputSchema.parse(
      await readJsonBody(request, 24 * 1024),
    );
    await services.identityAccess.authorizeBootstrapConfiguration(
      input.bootstrapToken,
      currentRequestId,
    );
    return NextResponse.json(await services.infrastructureCheck(input.target), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
