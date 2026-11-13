import { NextResponse } from "next/server";
import {
  publicSuiteLinkQuerySchema,
  terminatePublicSuiteExecutionSchema,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readOptionalJsonBody } from "@/lib/api-response";
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
    const input = terminatePublicSuiteExecutionSchema.parse(
      await readOptionalJsonBody(request, 512 * 1024),
    );
    const services = await getPlatformServices();
    if (
      !(await services.runnerRequestLimiter.allow(
        `public-suite-terminate:${identity.user.id}`,
        20,
        60000,
      ))
    )
      throw new DomainError("RATE_LIMITED", "操作过于频繁，请稍后重试。");
    const cancelledRuns = await services.publicSuiteExecutions.terminate(
      suiteId,
      query.PublisherId,
      batchId,
      { id: identity.user.id, username: identity.user.username, source: identity.user.source },
      input.confirmation,
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
