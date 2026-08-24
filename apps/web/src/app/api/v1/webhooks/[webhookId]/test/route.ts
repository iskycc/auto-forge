import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ webhookId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "project.manage");
    const webhookId = (await context.params).webhookId;
    const configuration = await services.webhooks.getConfiguration(webhookId, projectIds);
    const result = await services.webhooks.testConfiguration(webhookId, projectIds);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "webhook.test",
      resourceType: "webhook",
      resourceId: webhookId,
      ...(configuration ? { projectId: configuration.projectId } : {}),
      requestId: currentRequestId,
      details: result,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
