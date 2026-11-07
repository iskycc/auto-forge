import { NextResponse } from "next/server";
import { DomainError } from "@autoforge/domain";
import { apiErrorResponse } from "@/lib/api-response";
import {
  authenticateRequest,
  authorizedProjectScope,
  requireSameOrigin,
  requestId,
} from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };
async function publication(
  request: Request,
  context: Context,
  action: "read" | "publish" | "revoke",
) {
  const currentRequestId = requestId(request);
  try {
    if (action !== "read") requireSameOrigin(request);
    const actor = await authenticateRequest(request);
    const services = await getPlatformServices();
    const { batchId } = await context.params;
    const scope = await services.analysisPublications.requireBatch(batchId);
    authorizedProjectScope(actor, "analysis.manage", scope.projectId);
    if (action === "publish") {
      services.identityAccess.authorize(actor, "run.read", scope.projectId);
      services.identityAccess.authorize(actor, "log.read", scope.projectId);
      if (actor.sessionId.startsWith("api-token:"))
        throw new DomainError("AUTH_REQUIRED", "请使用个人账号登录后发布公开分析链接。");
      await services.analysisPublications.publish(batchId, actor.user.id);
    } else if (action === "revoke") await services.analysisPublications.revoke(batchId);
    if (action !== "read")
      await services.identityAccess.recordAuthorizedOperation(actor, {
        action: `failure_analysis.publication.${action}`,
        resourceType: "run_batch",
        resourceId: batchId,
        projectId: scope.projectId,
        requestId: currentRequestId,
      });
    return NextResponse.json(
      { path: await services.analysisPublications.link(batchId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    return apiErrorResponse(cause, currentRequestId);
  }
}
export async function GET(request: Request, context: Context) {
  return publication(request, context, "read");
}
export async function POST(request: Request, context: Context) {
  return publication(request, context, "publish");
}
export async function DELETE(request: Request, context: Context) {
  return publication(request, context, "revoke");
}
