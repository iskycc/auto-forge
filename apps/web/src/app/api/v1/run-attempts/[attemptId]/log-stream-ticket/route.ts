import { DomainError, isTerminalAttemptStatus } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { issueLogStreamTicket } from "@/lib/log-stream-ticket";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "log.read");
    if (new URL(request.url).searchParams.get("manualOnly") === "1") {
      const attempt = await services.runBatches.getManualAttemptContext(attemptId);
      services.identityAccess.authorize(identity, "log.read", attempt.projectId);
      if (isTerminalAttemptStatus(attempt.status)) {
        throw new DomainError("RUN_ATTEMPT_NOT_ACTIVE", "该手动执行已经结束，无需实时日志连接。");
      }
    } else
      await services.executionControl.listLogs({
        attemptId,
        stream: "stdout",
        afterSequence: -1,
        limit: 1,
        ...(projectIds ? { projectIds } : {}),
      });
    const secret = services.config.terminalAccessToken;
    if (!secret) {
      throw new DomainError(
        "LOG_STREAM_DISABLED",
        "实时日志通道未配置；仍可通过持久日志查询读取结果。",
      );
    }
    return NextResponse.json({
      schemaVersion: 1,
      ticket: issueLogStreamTicket(secret, {
        attemptId,
        actorId: identity.user.id,
        ttlSeconds: 120,
        now: services.clock.now(),
      }),
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
