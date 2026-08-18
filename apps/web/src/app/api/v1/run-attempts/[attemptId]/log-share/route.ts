import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export const dynamic = "force-dynamic";

/**
 * 为单个 attempt 创建日志公开访问链接，返回站内相对地址；权限沿用日志读取范围，
 * 链接创建记入审计。链接永久有效。
 */
export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "log.read");
    const token = await services.attemptLogShares.ensureShareForAttempt(
      attemptId,
      identity.user.id,
      projectIds,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "attempt_log.share",
      resourceType: "run_attempt",
      resourceId: attemptId,
      requestId: currentRequestId,
    });
    return NextResponse.json({ attemptId, shareUrl: `/share/attempt-log/${token}` });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
