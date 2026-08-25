import {
  probeRunnerHostRequestSchema,
  runnerHostProbeResultSchema,
  type RunnerHostConnection,
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
    const input = probeRunnerHostRequestSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:install:probe:v1:${identity.user.id}`,
        20,
        60_000,
      ),
    );
    let connection: RunnerHostConnection;
    let expectedHostKeySha256: string | undefined;
    if ("profileId" in input) {
      const stored = await services.runnerInstallationProfiles.connectionByProfileId(
        input.profileId,
      );
      connection = stored.connection;
      expectedHostKeySha256 = stored.profile.expectedHostKeySha256;
    } else {
      connection = input.connection;
    }
    const result = runnerHostProbeResultSchema.parse(
      await services.runnerAgentInstaller.probe(
        connection,
        input.installationMode,
        expectedHostKeySha256,
      ),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.install.probe",
      resourceType: "runner_host",
      resourceId: connection.host,
      requestId: currentRequestId,
      details: {
        operatingSystemId: result.operatingSystemId,
        detectedOperatingSystemId: result.detectedOperatingSystemId,
        forcedInstallationMode: result.forcedInstallationMode,
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
