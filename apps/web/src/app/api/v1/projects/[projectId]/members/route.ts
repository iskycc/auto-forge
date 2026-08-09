import { NextResponse } from "next/server";

import { authenticateRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { projectId } = await context.params;
    return NextResponse.json(
      await (await getPlatformServices()).identityAccess.listProjectMembers(identity, projectId),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
