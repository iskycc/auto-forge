import { timingSafeEqual } from "node:crypto";

import { createTerminalSessionInputSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { issueTerminalTicket } from "@/lib/terminal-ticket";
import { uuidV7 } from "@/lib/uuid-v7";

const SESSION_TICKET_TTL_SECONDS = 30;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const services = await getPlatformServices();
    if (!services.config.terminalAccessToken) {
      throw new DomainError("TERMINAL_DISABLED", "平台未启用直连终端。请先配置终端访问令牌。");
    }
    rejectRateLimited(
      await services.runnerRequestLimiter.allow("terminal:authorize:v1", 30, 60_000),
    );
    if (!secureEqual(bearerToken(request), services.config.terminalAccessToken)) {
      throw new DomainError("TERMINAL_AUTH_REJECTED", "终端访问令牌无效。");
    }
    const input = createTerminalSessionInputSchema.parse(await readJsonBody(request, 16 * 1024));
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `terminal:session:v1:${input.runnerId}`,
        10,
        60_000,
      ),
    );
    const runner = await services.runnerControl.get(input.runnerId);
    if (runner.state !== "online") {
      throw new DomainError("RUNNER_OFFLINE", "执行机当前离线，无法打开终端。");
    }
    if (!runner.terminalEnabled) {
      throw new DomainError("RUNNER_TERMINAL_DISABLED", "该执行机未启用直连终端。");
    }
    const sessionId = uuidV7();
    const issuedAt = new Date();
    return NextResponse.json({
      schemaVersion: 1,
      sessionId,
      connectionToken: issueTerminalTicket(services.config.terminalAccessToken, {
        role: "browser",
        runnerId: runner.id,
        sessionId,
        columns: input.columns,
        rows: input.rows,
        ttlSeconds: SESSION_TICKET_TTL_SECONDS,
        now: issuedAt,
      }),
      websocketPath: "/api/v1/terminal-stream",
      expiresAt: new Date(issuedAt.getTime() + SESSION_TICKET_TTL_SECONDS * 1000).toISOString(),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function secureEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
