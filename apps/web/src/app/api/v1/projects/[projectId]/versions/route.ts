import { createProjectVersionInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const input = createProjectVersionInputSchema.parse(await readJsonBody(request, 8 * 1_024));
    const version = await (
      await getPlatformServices()
    ).projectStructures.createVersion(projectId, input);
    return NextResponse.json(version, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
