import { randomUUID } from "node:crypto";

import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import {
  apiErrorResponse,
  bearerToken,
  logServerError,
  readJsonBody,
  rejectRateLimited,
} from "@/lib/api-response";
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
    // 一个 attempt 完成就立即补调度，让空闲出来的并发槽立刻领取下一个用例。
    if (response.disposition === "accepted" && response.batchId) {
      try {
        await services.runBatches.schedule(response.batchId);
      } catch (error) {
        logServerError(error, randomUUID(), "Completion-triggered scheduling failed");
      }
    }
    return NextResponse.json(response);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
