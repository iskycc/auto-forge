import { NextResponse } from "next/server";
import { renameProjectInputSchema } from "@autoforge/contracts";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ projectId: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId } = await context.params;
    const input = renameProjectInputSchema.parse(await readJsonBody(request, 8 * 1024));
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.renameProject(identity, projectId, input, currentRequestId),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId } = await context.params;
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.archiveProject(identity, projectId, currentRequestId),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
