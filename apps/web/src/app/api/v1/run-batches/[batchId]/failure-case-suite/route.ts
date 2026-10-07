import { createFailureCaseSuiteInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const services = await getPlatformServices();
    const readScope = services.identityAccess.projectScope(identity, "run.read");
    const batch = await services.runBatches.getSummary(batchId, readScope);
    services.identityAccess.authorize(identity, "case_suite.manage", batch.projectId);
    const suggestion = await services.caseSuites.suggestFinalFailureName(batchId, [
      batch.projectId,
    ]);
    return NextResponse.json(suggestion, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const input = createFailureCaseSuiteInputSchema.parse(await readJsonBody(request, 4 * 1024));
    const services = await getPlatformServices();
    const readScope = services.identityAccess.projectScope(identity, "run.read");
    const batch = await services.runBatches.getSummary(batchId, readScope);
    services.identityAccess.authorize(identity, "case_suite.manage", batch.projectId);
    const suite = await services.caseSuites.createFromFinalFailures(
      batchId,
      input,
      identity.user.id,
      [batch.projectId],
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.create_from_failures",
      resourceType: "case_suite",
      resourceId: suite.id,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: { sourceBatchId: batchId, sourceSuiteId: batch.suiteId, caseCount: suite.caseCount },
    });
    return NextResponse.json(suite, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
