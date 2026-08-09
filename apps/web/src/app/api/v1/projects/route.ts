import { createProjectInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    return NextResponse.json(
      await (await getPlatformServices()).identityAccess.listProjects(identity),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createProjectInputSchema.parse(await readJsonBody(request, 8 * 1024));
    const project = await (
      await getPlatformServices()
    ).identityAccess.createProject(identity, input, currentRequestId);
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
