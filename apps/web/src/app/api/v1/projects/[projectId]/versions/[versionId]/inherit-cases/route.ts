import { z } from "zod";
import { NextResponse } from "next/server";

import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ projectId: string; versionId: string }> };

const inputSchema = z.object({
  sourceProjectVersionId: z.string().min(1).max(128),
  sourceTestStageId: z.string().min(1).max(128),
  targetTestStageId: z.string().min(1).max(128),
});

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "case.manage", projectId);
    const input = inputSchema.parse(await readJsonBody(request, 16 * 1_024));
    const services = await getPlatformServices();
    const result = await services.caseDefinitions.inheritFromVersion({
      projectId,
      sourceProjectVersionId: input.sourceProjectVersionId,
      sourceTestStageId: input.sourceTestStageId,
      targetProjectVersionId: versionId,
      targetTestStageId: input.targetTestStageId,
      actorId: identity.user.id,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_definition.inherit_version",
      resourceType: "project_version",
      resourceId: versionId,
      projectId,
      requestId: currentRequestId,
      details: result,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
