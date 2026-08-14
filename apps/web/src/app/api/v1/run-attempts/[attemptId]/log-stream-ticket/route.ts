import { DomainError } from "@autoforge/domain";
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
      }),
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
