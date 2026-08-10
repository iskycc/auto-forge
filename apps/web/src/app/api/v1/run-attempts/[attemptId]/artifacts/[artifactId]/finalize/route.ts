import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string; artifactId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    const leaseToken = request.headers.get("x-autoforge-lease-token")?.trim();
    if (!runnerId || !leaseToken) {
      throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机或租约凭据。");
    }
    const { attemptId, artifactId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:artifact-finalize:v1:${runnerId}`,
        300,
        60_000,
      ),
    );
    const result = await services.executionControl.finalizeArtifactUpload({
      runnerId,
      credential: bearerToken(request),
      attemptId,
      artifactId,
      leaseToken,
    });
    return NextResponse.json({ artifactId: result.artifactId, status: result.status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
