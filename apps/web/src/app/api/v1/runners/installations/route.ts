import {
  installRunnerAgentInputSchema,
  runnerAgentInstallationResultSchema,
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
    const input = installRunnerAgentInputSchema.parse(await readJsonBody(request, 96 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:install:execute:v1:${identity.user.id}`,
        5,
        60_000,
      ),
    );
    const result = runnerAgentInstallationResultSchema.parse(
      await services.runnerAgentInstaller.install(input),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.install.complete",
      resourceType: "runner_host",
      resourceId: input.connection.host,
      requestId: currentRequestId,
      details: {
        name: input.name,
        architecture: result.architecture,
        agentVersion: result.agentVersion,
      },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
