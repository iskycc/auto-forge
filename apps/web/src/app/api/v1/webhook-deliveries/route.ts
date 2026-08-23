import { webhookDeliveryListQuerySchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, authorizedProjectScope, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const query = webhookDeliveryListQuerySchema.parse({
      projectId: url.searchParams.get("projectId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    authorizedProjectScope(identity, "project.read", query.projectId);
    return NextResponse.json({
      items: await (
        await getPlatformServices()
      ).webhooks.listDeliveries(query.projectId, query.limit),
    });
  } catch (error) {
    return apiErrorResponse(error, requestId(request));
  }
}
