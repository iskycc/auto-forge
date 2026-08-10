import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    if (!runnerId) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`runner:secrets:v1:${runnerId}`, 60, 60_000),
    );
    return NextResponse.json(
      await services.runnerProtocol.acquireSecrets(
        runnerId,
        bearerToken(request),
        attemptId,
        await readJsonBody(request, 8 * 1024),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
