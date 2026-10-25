import { RUNNER_COMPLETE_BODY_LIMIT_BYTES } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { refillRunnerAfterCompletion } from "@/lib/refill-runner-after-completion";
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
    // 槽位属于执行机，同优先级任务共同参与补位，避免原批次不断抢回自己释放的槽。
    await refillRunnerAfterCompletion(response, () =>
      services.runScheduling.scheduleForRunner(runnerId),
    );
    return NextResponse.json(response);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
