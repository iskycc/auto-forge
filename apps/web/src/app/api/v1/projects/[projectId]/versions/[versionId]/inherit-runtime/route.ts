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
  expectedRevision: z.number().int().nonnegative(),
});

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const input = inputSchema.parse(await readJsonBody(request, 16 * 1_024));
    const services = await getPlatformServices();
    const configuration = await services.projectStructures.inheritAdapterConfiguration({
      projectId,
      sourceProjectVersionId: input.sourceProjectVersionId,
      targetProjectVersionId: versionId,
      expectedRevision: input.expectedRevision,
      actorId: identity.user.id,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "project_version.runtime_inherit",
      resourceType: "project_version",
      resourceId: versionId,
      projectId,
      requestId: currentRequestId,
      details: { sourceProjectVersionId: input.sourceProjectVersionId },
    });
    return NextResponse.json(configuration);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
