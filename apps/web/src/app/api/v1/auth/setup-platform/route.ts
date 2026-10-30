import { initializePlatformConfigurationInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { DomainError } from "@autoforge/domain";

import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { clientAddress, requestId, requireSameOrigin } from "@/lib/auth";
import {
  mergePlatformConfiguration,
  platformConfigurationError,
  platformConfigurationView,
} from "@/lib/platform-configuration";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `auth:setup-platform:v1:${clientAddress(request)}`,
        5,
        15 * 60_000,
      ),
    );
    const input = initializePlatformConfigurationInputSchema.parse(
      await readJsonBody(request, 32 * 1024),
    );
    await services.identityAccess.authorizeBootstrapConfiguration(
      input.bootstrapToken,
      currentRequestId,
    );
    const current = services.configurationStore.read();
    const next = mergePlatformConfiguration(current, input.configuration);
    if (next.mode === "full" && !next.full?.logServer)
      throw new DomainError(
        "LOG_DAILY_SERVER_REQUIRED",
        "Full 初始化必须配置独立 PostgreSQL 日志服务器，不支持本地 SQLite 日志写入。",
      );
    const saved = services.configurationStore.replace(next, input.configuration.revision);
    await services.identityAccess.recordBootstrapConfiguration(
      { mode: saved.mode, revision: saved.revision },
      currentRequestId,
    );
    return NextResponse.json(
      platformConfigurationView(saved, services.configurationStore.paths.configurationFile, true),
    );
  } catch (error) {
    return apiErrorResponse(platformConfigurationError(error), currentRequestId);
  }
}
