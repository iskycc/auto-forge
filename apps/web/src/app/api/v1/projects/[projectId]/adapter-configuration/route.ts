import { projectAdapterConfigurationInputSchema } from "@autoforge/contracts";
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

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { projectId } = await context.params;
    authorizedProjectScope(identity, "project.read", projectId);
    const structure = await (await getPlatformServices()).projectStructures.list(projectId);
    return NextResponse.json(structure.adapterConfiguration);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const input = projectAdapterConfigurationInputSchema.parse(
      await readJsonBody(request, 32 * 1_024),
    );
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).projectStructures.updateAdapterConfiguration(projectId, input, identity.user.id),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
