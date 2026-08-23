import { replaceCaseSuiteWebhooksInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.read");
    const suiteId = (await context.params).suiteId;
    await services.caseSuites.get(suiteId, projectIds);
    return NextResponse.json({
      webhookIds: await services.webhooks.listSuiteBindings(suiteId, projectIds),
    });
  } catch (error) {
    return apiErrorResponse(error, requestId(request));
  }
}

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const suiteId = (await context.params).suiteId;
    const input = replaceCaseSuiteWebhooksInputSchema.parse(
      await readJsonBody(request, 16 * 1_024),
    );
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const webhookIds = await services.webhooks.replaceSuiteBindings(
      suiteId,
      input.webhookIds,
      projectIds,
    );
    const suite = await services.caseSuites.get(suiteId, projectIds);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.webhooks_update",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: { webhookCount: webhookIds.length },
    });
    return NextResponse.json({ webhookIds });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
