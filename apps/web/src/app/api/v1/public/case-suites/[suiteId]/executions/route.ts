import { NextResponse } from "next/server";
import { publicSuiteLinkQuerySchema, startPublicSuiteExecutionSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request, context: { params: Promise<{ suiteId: string }> }) {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    if (identity.sessionId.startsWith("api-token:"))
      throw new DomainError(
        "AUTH_REQUIRED",
        "公开执行入口需要登录浏览器账号；Jenkins 请使用专用 API。",
      );
    const { suiteId } = await context.params;
    const query = publicSuiteLinkQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const input = startPublicSuiteExecutionSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    if (
      !(await services.runnerRequestLimiter.allow(
        `public-suite-start:${identity.user.id}`,
        20,
        60000,
      ))
    )
      throw new DomainError("RATE_LIMITED", "操作过于频繁，请稍后重试。");
    const result = await services.publicSuiteExecutions.start(suiteId, query.PublisherId, input, {
      id: identity.user.id,
      username: identity.user.username,
      source: identity.user.source,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "public_suite.execution.start",
      resourceType: "run_batch",
      resourceId: result.batchId,
      requestId: id,
      details: { suiteId, publisherId: query.PublisherId, delaySeconds: input.delaySeconds },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
