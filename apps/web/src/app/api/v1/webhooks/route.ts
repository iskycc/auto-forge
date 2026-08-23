import { createWebhookConfigurationInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({ projectId: z.string().min(1).max(128) });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { projectId } = querySchema.parse({
      projectId: new URL(request.url).searchParams.get("projectId") ?? undefined,
    });
    authorizedProjectScope(identity, "project.read", projectId);
    return NextResponse.json({
      items: await (await getPlatformServices()).webhooks.listConfigurations(projectId),
    });
  } catch (error) {
    return apiErrorResponse(error, requestId(request));
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createWebhookConfigurationInputSchema.parse(
      await readJsonBody(request, 80 * 1_024),
    );
    authorizedProjectScope(identity, "project.manage", input.projectId);
    const services = await getPlatformServices();
    const configuration = await services.webhooks.createConfiguration(input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "webhook.create",
      resourceType: "webhook",
      resourceId: configuration.id,
      projectId: configuration.projectId,
      requestId: currentRequestId,
      details: { method: configuration.method, enabled: configuration.enabled },
    });
    return NextResponse.json(configuration, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
