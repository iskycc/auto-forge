import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { refillBatchAfterCompletion } from "@/lib/refill-batch-after-completion";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    if (!runnerId) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`runner:complete:v1:${runnerId}`, 300, 60_000),
    );
    const response = await services.runnerProtocol.complete(
      runnerId,
      bearerToken(request),
      attemptId,
      await readJsonBody(request, 512 * 1024),
    );
    // accepted 与 duplicate 都可能来自一次已持久化的完成上报。调度本身幂等，
    // 因此重放时也补做一次，覆盖上次响应丢失或调度触发失败的恢复窗口。
    await refillBatchAfterCompletion(response, (batchId) =>
      services.runScheduling.schedule(batchId),
    );
    return NextResponse.json(response);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
