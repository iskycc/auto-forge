import { setCaseSuitePinInputSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function PUT(
  request: Request,
  context: { params: Promise<{ suiteId: string }> },
): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    if (identity.sessionId.startsWith("api-token:"))
      throw new DomainError("AUTH_FORBIDDEN", "服务账号不能设置个人任务置顶。");
    const input = setCaseSuitePinInputSchema.parse(await readJsonBody(request, 1024));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.read");
    const { suiteId } = await context.params;
    const result = await services.caseSuites.setPinned(
      suiteId,
      input,
      identity.user.id,
      projectIds,
    );
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
