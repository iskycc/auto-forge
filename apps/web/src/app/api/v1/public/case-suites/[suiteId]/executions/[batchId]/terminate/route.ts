import { NextResponse } from "next/server";
import { publicSuiteLinkQuerySchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(
  request: Request,
  context: { params: Promise<{ suiteId: string; batchId: string }> },
) {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    if (identity.sessionId.startsWith("api-token:"))
      throw new DomainError("AUTH_REQUIRED", "请登录后终止任务。");
    const { suiteId, batchId } = await context.params;
    const query = publicSuiteLinkQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const services = await getPlatformServices();
    const cancelledRuns = await services.publicSuiteExecutions.terminate(
      suiteId,
      query.PublisherId,
      batchId,
      { id: identity.user.id, username: identity.user.username, source: identity.user.source },
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "public_suite.execution.terminate",
      resourceType: "run_batch",
      resourceId: batchId,
      requestId: id,
      details: { suiteId, publisherId: query.PublisherId, cancelledRuns },
    });
    return NextResponse.json({ batchId, cancelledRuns });
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
