import {
  runnerAgentInstallationResultSchema,
  updateRunnerAgentInputSchema,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export const runtime = "nodejs";

type Context = { params: Promise<{ runnerId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "runner.manage");
    const { runnerId } = await context.params;
    const input = updateRunnerAgentInputSchema.parse(await readJsonBody(request, 96 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:update:execute:v1:${identity.user.id}`,
        5,
        60_000,
      ),
    );
    const runner = await services.runnerControl.get(runnerId);
    if (runner.deregisteredAt || runner.purgedAt) {
      throw new DomainError("RUNNER_UPDATE_NOT_ALLOWED", "执行机已注销，不能原地更新。", {
        details: { runnerId },
      });
    }
    // 原地更新保留执行机既有配置与身份：名称、标签、并发与终端开关以平台记录为准，
    // 不允许通过更新动作改动；Agent 侧已有持久身份时会忽略新 bootstrap token。
    const result = runnerAgentInstallationResultSchema.parse(
      await services.runnerAgentInstaller.install({
        ...input,
        name: runner.name,
        labels: runner.labels,
        maxConcurrency: runner.maxConcurrency,
        terminalEnabled: runner.terminalEnabled,
      }),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.update.complete",
      resourceType: "runner",
      resourceId: runnerId,
      requestId: currentRequestId,
      details: {
        host: input.connection.host,
        fromVersion: runner.agentVersion,
        toVersion: result.agentVersion,
        runAsRoot: input.runAsRoot,
        installationMode: input.installationMode,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
