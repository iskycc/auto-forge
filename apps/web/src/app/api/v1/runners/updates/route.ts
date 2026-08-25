import {
  batchUpdateRunnerAgentsInputSchema,
  batchUpdateRunnerAgentsResultSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { upgradeRunnerAgent } from "@/lib/runner-agent-update";
import { getPlatformServices, type PlatformServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "runner.manage");
    const input = batchUpdateRunnerAgentsInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `runner:update:batch:v1:${identity.user.id}`,
        3,
        60_000,
      ),
    );
    const items = await mapWithConcurrency(input.runnerIds, 4, (runnerId) =>
      updateOne(services, runnerId),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "runner.update.batch",
      resourceType: "runner",
      resourceId: input.runnerIds.join(","),
      requestId: currentRequestId,
      details: {
        requested: input.runnerIds.length,
        updated: items.filter((item) => item.status === "updated").length,
        failed: items.filter((item) => item.status === "failed").length,
        missingProfile: items.filter((item) => item.status === "missing_profile").length,
      },
    });
    return NextResponse.json(batchUpdateRunnerAgentsResultSchema.parse({ items }));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

async function updateOne(services: PlatformServices, runnerId: string) {
  let runnerName = runnerId;
  try {
    const runner = await services.runnerControl.get(runnerId);
    runnerName = runner.name;
    const stored = await services.runnerInstallationProfiles.connectionForRunner(runnerId);
    if (!stored) {
      return {
        runnerId,
        runnerName: runner.name,
        status: "missing_profile" as const,
        message: "没有已保存的连接信息，请先单独更新一次并核验主机指纹。",
      };
    }
    const target = {
      connection: stored.connection,
      expectedHostKeySha256: stored.profile.expectedHostKeySha256,
      installationMode: stored.profile.installationMode,
    };
    const result = await upgradeRunnerAgent(services.runnerAgentInstaller, runner, target);
    return {
      runnerId,
      runnerName: runner.name,
      status: "updated" as const,
      message: `已更新到 Agent ${result.agentVersion}。`,
      agentVersion: result.agentVersion,
    };
  } catch (error) {
    return {
      runnerId,
      runnerName,
      status: "failed" as const,
      message: error instanceof Error ? error.message : "更新失败。",
    };
  }
}

async function mapWithConcurrency<TInput, TResult>(
  inputs: readonly TInput[],
  concurrency: number,
  operation: (input: TInput) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(inputs[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
