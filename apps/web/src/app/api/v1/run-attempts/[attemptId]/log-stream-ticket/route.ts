import { DomainError, isTerminalAttemptStatus } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { authorizeAttemptRead } from "@/lib/execution-public-access";
import { issueLogStreamTicket } from "@/lib/log-stream-ticket";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    const manualOnly = new URL(request.url).searchParams.get("manualOnly") === "1";
    let actorId: string;
    if (manualOnly) {
      const identity = await authenticateRequest(request);
      const attempt = await services.runBatches.getManualAttemptContext(attemptId);
      services.identityAccess.authorize(identity, "log.read", attempt.projectId);
      if (isTerminalAttemptStatus(attempt.status)) {
        throw new DomainError("RUN_ATTEMPT_NOT_ACTIVE", "该手动执行已经结束，无需实时日志连接。");
      }
      actorId = identity.user.id;
    } else {
      const access = await authorizeAttemptRead(request, attemptId, "log.read", services);
      actorId = access.actorId;
      if (!access.shared)
        await services.executionControl.listLogs({
          attemptId,
          stream: "stdout",
          afterSequence: -1,
          limit: 1,
          ...(access.projectIds ? { projectIds: access.projectIds } : {}),
        });
    }
    const secret = services.config.terminalAccessToken;
    if (!secret) {
      throw new DomainError(
        "LOG_STREAM_DISABLED",
        "实时日志通道未配置；仍可通过持久日志查询读取结果。",
      );
    }
    return NextResponse.json(
      {
        schemaVersion: 1,
        ticket: issueLogStreamTicket(secret, {
          attemptId,
          actorId,
          ttlSeconds: 120,
          now: services.clock.now(),
        }),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
