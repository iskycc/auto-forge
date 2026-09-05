import { createTerminalSessionInputSchema } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID, DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { issueTerminalTicket } from "@/lib/terminal-ticket";
import { uuidV7 } from "@autoforge/ids";

const SESSION_TICKET_TTL_SECONDS = 30;

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const services = await getPlatformServices();
    if (!services.config.terminalAccessToken) {
      throw new DomainError("TERMINAL_DISABLED", "平台未启用直连终端。请先配置终端访问令牌。");
    }
    rejectRateLimited(
      await services.runnerRequestLimiter.allow("terminal:authorize:v1", 30, 60_000),
    );
    const identity = await authenticateRequest(request);
    services.identityAccess.authorize(identity, "runner.terminal", DEFAULT_PROJECT_ID);
    const input = createTerminalSessionInputSchema.parse(await readJsonBody(request, 16 * 1024));
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `terminal:session:v1:${input.runnerId}`,
        10,
        60_000,
      ),
    );
    const runner = await services.runnerControl.get(input.runnerId);
    if (runner.deregisteredAt || runner.credentialRevokedAt) {
      throw new DomainError("RUNNER_OFFLINE", "执行机已注销或凭据已撤销，无法打开终端。");
    }
    if (runner.state !== "online") {
      throw new DomainError("RUNNER_OFFLINE", "执行机当前离线，无法打开终端。");
    }
    if (!runner.terminalEnabled) {
      throw new DomainError("RUNNER_TERMINAL_DISABLED", "该执行机未启用直连终端。");
    }
    const sessionId = uuidV7();
    const issuedAt = services.clock.now();
    await services.identityAccess.recordTerminalSession(
      identity,
      runner.id,
      sessionId,
      DEFAULT_PROJECT_ID,
      currentRequestId,
    );
    return NextResponse.json({
      schemaVersion: 1,
      sessionId,
      connectionToken: issueTerminalTicket(services.config.terminalAccessToken, {
        role: "browser",
        runnerId: runner.id,
        sessionId,
        actorId: identity.user.id,
        columns: input.columns,
        rows: input.rows,
        ttlSeconds: SESSION_TICKET_TTL_SECONDS,
        now: issuedAt,
      }),
      websocketPath: "/api/v1/terminal-stream",
      expiresAt: new Date(issuedAt.getTime() + SESSION_TICKET_TTL_SECONDS * 1000).toISOString(),
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
