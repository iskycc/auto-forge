import { RUNNER_COMPLETE_BODY_LIMIT_BYTES } from "@autoforge/contracts";
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
      await readJsonBody(request, RUNNER_COMPLETE_BODY_LIMIT_BYTES),
    );
    // accepted 与 duplicate 都可能来自一次已持久化的完成上报。调度本身幂等，
    // 因此重放时也补做一次，覆盖上次响应丢失或调度触发失败的恢复窗口。
    // 仓储在提交快照中给出可调度探针：明确无可调度 run 时跳过补调度，避免
    // 每次完成都支付一次调度短路查询（高并发完成主路径）。
    await refillBatchAfterCompletion(response, (batchId) =>
      response.hasSchedulableRuns === false
        ? Promise.resolve()
        : services.runScheduling.schedule(batchId),
    );
    return NextResponse.json(response);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
