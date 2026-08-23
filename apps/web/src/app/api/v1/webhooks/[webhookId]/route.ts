import { updateWebhookConfigurationInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ webhookId: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "project.manage");
    const configuration = await services.webhooks.updateConfiguration(
      (await context.params).webhookId,
      updateWebhookConfigurationInputSchema.parse(await readJsonBody(request, 80 * 1_024)),
      projectIds,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "webhook.update",
      resourceType: "webhook",
      resourceId: configuration.id,
      projectId: configuration.projectId,
      requestId: currentRequestId,
      details: {
        method: configuration.method,
        enabled: configuration.enabled,
        revision: configuration.revision,
      },
    });
    return NextResponse.json(configuration);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "project.manage");
    const webhookId = (await context.params).webhookId;
    const configuration = await services.webhooks.getConfiguration(webhookId, projectIds);
    await services.webhooks.deleteConfiguration(webhookId, projectIds);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "webhook.delete",
      resourceType: "webhook",
      resourceId: webhookId,
      ...(configuration ? { projectId: configuration.projectId } : {}),
      requestId: currentRequestId,
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
