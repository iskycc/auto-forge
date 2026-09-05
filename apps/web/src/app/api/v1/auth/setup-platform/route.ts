import { initializePlatformConfigurationInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

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
    const saved = services.configurationStore.replace(
      mergePlatformConfiguration(current, input.configuration),
      input.configuration.revision,
    );
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
