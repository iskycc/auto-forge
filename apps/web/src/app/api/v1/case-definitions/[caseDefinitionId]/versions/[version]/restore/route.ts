import { NextResponse } from "next/server";
import { z } from "zod";

import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ caseDefinitionId: string; version: string }> };

const versionSchema = z.coerce.number().int().min(1);

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case.manage");
    const { caseDefinitionId, version } = await context.params;
    const parsedVersion = versionSchema.parse(version);
    const services = await getPlatformServices();
    const definition = await services.caseDefinitions.restoreVersion(
      caseDefinitionId,
      parsedVersion,
      identity.user.id,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_definition.restore_version",
      resourceType: "case_definition",
      resourceId: caseDefinitionId,
      requestId: currentRequestId,
      details: { restoredFromVersion: parsedVersion, currentVersion: definition.currentVersion },
    });
    return NextResponse.json(definition);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
