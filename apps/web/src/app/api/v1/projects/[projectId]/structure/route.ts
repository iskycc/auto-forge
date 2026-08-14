import { NextResponse } from "next/server";

import { authenticateRequest, authorizedProjectScope, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { projectId } = await context.params;
    authorizedProjectScope(identity, "project.read", projectId);
    const structure = await (await getPlatformServices()).projectStructures.list(projectId);
    return NextResponse.json(structure);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
