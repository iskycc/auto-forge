import {
  rollbackRunnerAgentInputSchema,
  runnerAgentRollbackResultSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "runner.manage");
    const input = rollbackRunnerAgentInputSchema.parse(await readJsonBody(request, 32 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:install:rollback:v1:${identity.user.id}`,
        3,
        60_000,
      ),
    );
    const result = runnerAgentRollbackResultSchema.parse(
      await services.runnerAgentInstaller.rollback(input),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.install.rollback",
      resourceType: "runner_host",
      resourceId: input.connection.host,
      requestId: currentRequestId,
      details: { agentVersion: result.agentVersion },
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
