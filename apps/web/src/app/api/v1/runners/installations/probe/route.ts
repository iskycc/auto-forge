import { probeRunnerHostInputSchema, runnerHostProbeResultSchema } from "@autoforge/contracts";
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
    const input = probeRunnerHostInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:install:probe:v1:${identity.user.id}`,
        20,
        60_000,
      ),
    );
    const result = runnerHostProbeResultSchema.parse(
      await services.runnerAgentInstaller.probe(input.connection),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.install.probe",
      resourceType: "runner_host",
      resourceId: input.connection.host,
      requestId: currentRequestId,
      details: {
        operatingSystemId: result.operatingSystemId,
        architecture: result.architecture,
        cgroupV2Available: result.cgroupV2Available,
        hostKeySha256: result.hostKeySha256,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
