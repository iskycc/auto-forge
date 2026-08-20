import {
  installRunnerAgentRequestSchema,
  type InstallRunnerAgentInput,
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
    const requestInput = installRunnerAgentRequestSchema.parse(
      await readJsonBody(request, 96 * 1024),
    );
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:install:execute:v1:${identity.user.id}`,
        5,
        60_000,
      ),
    );
    let input: InstallRunnerAgentInput;
    if ("profileId" in requestInput) {
      const stored = await services.runnerInstallationProfiles.connectionByProfileId(
        requestInput.profileId,
      );
      input = {
        connection: stored.connection,
        expectedHostKeySha256: stored.profile.expectedHostKeySha256,
        name: requestInput.name,
        labels: requestInput.labels,
        maxConcurrency: requestInput.maxConcurrency,
        terminalEnabled: requestInput.terminalEnabled,
        runAsRoot: stored.profile.runAsRoot,
        installationMode: stored.profile.installationMode,
        ...(stored.profile.dataDirectory ? { dataDirectory: stored.profile.dataDirectory } : {}),
        ...(stored.caCertificatePem ? { caCertificatePem: stored.caCertificatePem } : {}),
      };
    } else {
      input = requestInput;
    }
    const installed = await services.runnerAgentInstaller.install(input);
    // Agent 可能在 systemd 健康检查完成前已经注册；此时直接绑定。若仍未注册，
    // 先保存为 pending，注册入口会按名称补绑，覆盖两种时序。
    const registeredRunner = (await services.runnerControl.list(500)).find(
      (runner) => runner.name === input.name && !runner.deregisteredAt && !runner.purgedAt,
    );
    const profile = await services.runnerInstallationProfiles.save({
      ...(registeredRunner ? { runnerId: registeredRunner.id } : {}),
      runnerName: input.name,
      connection: input.connection,
      expectedHostKeySha256: input.expectedHostKeySha256,
      installationMode: input.installationMode,
      runAsRoot: input.runAsRoot,
      ...(input.dataDirectory ? { dataDirectory: input.dataDirectory } : {}),
      ...(input.caCertificatePem ? { caCertificatePem: input.caCertificatePem } : {}),
    });
    const result = runnerAgentInstallationResultSchema.parse({
      ...installed,
      profileId: profile.id,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.install.complete",
      resourceType: "runner_host",
      resourceId: input.connection.host,
      requestId: currentRequestId,
      details: {
        name: input.name,
        architecture: result.architecture,
        agentVersion: result.agentVersion,
        runAsRoot: input.runAsRoot,
        installationMode: input.installationMode,
      },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
