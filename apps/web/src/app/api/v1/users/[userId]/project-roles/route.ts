import { assignProjectRoleInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ userId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { userId } = await context.params;
    const input = assignProjectRoleInputSchema.parse(await readJsonBody(request, 4 * 1024));
    await (
      await getPlatformServices()
    ).identityAccess.assignProjectRole(
      identity,
      userId,
      input.projectId,
      input.roleId,
      currentRequestId,
    );
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
