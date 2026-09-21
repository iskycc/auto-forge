import { platformNodeIdSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(
  request: Request,
  context: { params: Promise<{ nodeId: string }> },
): Promise<NextResponse> {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    await authorizeRequest(request, "settings.manage", undefined);
    const nodeId = platformNodeIdSchema.parse((await context.params).nodeId);
    const services = await getPlatformServices();
    if (!services.nodeLogs)
      throw new DomainError("PLATFORM_NODE_NOT_FOUND", "分布式平台节点管理未启用。");
    if (!(await services.runnerRequestLimiter.allow(`platform-node-check:${nodeId}`, 1, 10_000)))
      throw new DomainError("PLATFORM_BUSY", "节点检查过于频繁，请十秒后重试。");
    await services.nodeLogs.checkConnectivity(nodeId);
    return NextResponse.json({ nodeId, checkedAt: services.clock.now().toISOString() });
  } catch (error) {
    return apiErrorResponse(error, id);
  }
}
