import { runtimeAssetUrlInputSchema } from "@autoforge/contracts";
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
    const input = runtimeAssetUrlInputSchema.parse(await readJsonBody(request, 16 * 1_024));
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).projectStructures.createUrlAsset(projectId, input, identity.user.id),
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
