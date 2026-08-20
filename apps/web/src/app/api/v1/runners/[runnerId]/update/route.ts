import {
  runnerAgentInstallationResultSchema,
  updateRunnerAgentRequestSchema,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { updateRunnerAgent, type RunnerAgentUpdateTarget } from "@/lib/runner-agent-update";

export const runtime = "nodejs";

type Context = { params: Promise<{ runnerId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "runner.manage");
    const { runnerId } = await context.params;
    const input = updateRunnerAgentRequestSchema.parse(await readJsonBody(request, 96 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:update:execute:v1:${identity.user.id}`,
        5,
        60_000,
      ),
    );
    const runner = await services.runnerControl.get(runnerId);
    let target: RunnerAgentUpdateTarget;
    if ("profileId" in input) {
      const stored = await services.runnerInstallationProfiles.connectionByProfileId(
        input.profileId,
      );
      if (stored.profile.runnerId && stored.profile.runnerId !== runnerId) {
        throw new DomainError(
          "RUNNER_INSTALLATION_PROFILE_MISMATCH",
          "保存的连接信息不属于当前执行机。",
        );
      }
      target = {
        connection: stored.connection,
        expectedHostKeySha256: stored.profile.expectedHostKeySha256,
        installationMode: stored.profile.installationMode,
        runAsRoot: stored.profile.runAsRoot,
        ...(stored.profile.dataDirectory ? { dataDirectory: stored.profile.dataDirectory } : {}),
        ...(stored.caCertificatePem ? { caCertificatePem: stored.caCertificatePem } : {}),
      };
    } else {
      target = {
        connection: input.connection,
        expectedHostKeySha256: input.expectedHostKeySha256,
        installationMode: input.installationMode,
        runAsRoot: input.runAsRoot,
        ...(input.dataDirectory ? { dataDirectory: input.dataDirectory } : {}),
        ...(input.caCertificatePem ? { caCertificatePem: input.caCertificatePem } : {}),
      };
    }
    const updated = await updateRunnerAgent(services.runnerAgentInstaller, runner, target);
    const profile = await services.runnerInstallationProfiles.save({
      runnerId,
      runnerName: runner.name,
      ...target,
      dataDirectory: updated.dataDirectory,
    });
    const result = runnerAgentInstallationResultSchema.parse({ ...updated, profileId: profile.id });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.update.complete",
      resourceType: "runner",
      resourceId: runnerId,
      requestId: currentRequestId,
      details: {
        host: target.connection.host,
        fromVersion: runner.agentVersion,
        toVersion: result.agentVersion,
        runAsRoot: target.runAsRoot,
        installationMode: target.installationMode,
        dataDirectory: updated.dataDirectory,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
