import { updatePlatformConfigurationInputSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { isPlatformConfigurationConflictError } from "@autoforge/platform-config";
import { NextResponse } from "next/server";

import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import {
  mergePlatformConfiguration,
  platformConfigurationView,
} from "@/lib/platform-configuration";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "settings.read", undefined);
    const services = await getPlatformServices();
    const configuration = services.configurationStore.read();
    return NextResponse.json(
      platformConfigurationView(configuration, services.configurationStore.paths.configurationFile),
    );
  } catch (error) {
    return apiErrorResponse(platformConfigurationError(error), currentRequestId);
  }
}

function platformConfigurationError(error: unknown): unknown {
  if (!isPlatformConfigurationConflictError(error)) return error;
  return new DomainError("PLATFORM_CONFIGURATION_CONFLICT", error.message, { cause: error });
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    const services = await getPlatformServices();
    const input = updatePlatformConfigurationInputSchema.parse(
      await readJsonBody(request, 32 * 1024),
    );
    const current = services.configurationStore.read();
    const next = mergePlatformConfiguration(current, input);
    const saved = services.configurationStore.replace(next, input.revision);
    await services.identityAccess.recordPlatformConfigurationChange(
      identity,
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
