import {
  uninstallRunnerAgentRequestSchema,
  runnerAgentUninstallResultSchema,
} from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { uninstallRunnerAgent } from "@/lib/runner-agent-uninstall";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ runnerId: string }> },
): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "runner.manage", DEFAULT_PROJECT_ID);
    const { runnerId } = await context.params;
    const input = uninstallRunnerAgentRequestSchema.parse(await readJsonBody(request, 32 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:uninstall:v1:${identity.user.id}`,
        5,
        60_000,
      ),
    );
    const result = runnerAgentUninstallResultSchema.parse(
      await uninstallRunnerAgent(services, runnerId, input),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.uninstall.complete",
      resourceType: "runner",
      resourceId: runnerId,
      requestId: currentRequestId,
      details: {
        dataDirectory: result.dataDirectory,
        dataDirectoryRetained: result.dataDirectoryRetained,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
