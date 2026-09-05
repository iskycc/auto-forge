import { randomUUID } from "node:crypto";

import { runnerHeartbeatInputSchema } from "@autoforge/contracts";
import {
  apiErrorResponse,
  bearerToken,
  logServerError,
  readJsonBody,
  rejectRateLimited,
} from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { issueTerminalTicket } from "@/lib/terminal-ticket";
import { NextResponse } from "next/server";

type Context = { params: Promise<{ runnerId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const input = runnerHeartbeatInputSchema.parse(await readJsonBody(request, 64 * 1024));
    const { runnerId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`runner:heartbeat:v1:${runnerId}`, 120, 60_000),
    );
    const heartbeat = await services.runnerControl.heartbeat(runnerId, bearerToken(request), input);
    if (!heartbeat.draining) {
      try {
        await services.runScheduling.scheduleForRunner(runnerId);
      } catch (error) {
        logServerError(error, randomUUID(), "Heartbeat-triggered scheduling failed");
      }
    }
    const terminalConnectionToken =
      input.terminalEnabled && !heartbeat.disabled && services.config.terminalAccessToken
        ? issueTerminalTicket(services.config.terminalAccessToken, {
            role: "agent",
            runnerId,
            ttlSeconds: 90,
            now: services.clock.now(),
          })
        : undefined;
    return NextResponse.json({
      ...heartbeat,
      ...(terminalConnectionToken ? { terminalConnectionToken } : {}),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
