import { platformNodeIdSchema, updatePlatformNodeSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ nodeId: string }> },
): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    const services = await getPlatformServices();
    if (!services.platformNodes)
      throw new DomainError("PLATFORM_NODE_NOT_FOUND", "分布式平台节点管理未启用。");
    const id = platformNodeIdSchema.parse((await context.params).nodeId);
    const input = updatePlatformNodeSchema.parse(await readJsonBody(request, 4096));
    const saved = await services.platformNodes.update(
      id,
      input,
      services.clock.now().toISOString(),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "platform.node_updated",
      resourceType: "platform_node",
      resourceId: id,
      requestId: currentRequestId,
      details: {
        revision: saved.revision,
        internalBaseUrl: saved.internalBaseUrl,
        name: saved.name,
      },
    });
    return NextResponse.json(saved);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
