import { inspectRoundRecoveryConfigurationInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const suiteId = (await context.params).suiteId;
    const suite = await services.caseSuites.get(suiteId, projectIds);
    const input = inspectRoundRecoveryConfigurationInputSchema.parse(
      await readJsonBody(request, 8 * 1_024),
    );
    const inspection = await services.roundRecoveryConfigurationInspector.inspect(suite, input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.round_recovery_inspect",
      resourceType: "case_suite",
      resourceId: suite.id,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: {
        ruleId: input.ruleId,
        jenkinsJobUrl: input.jenkinsJobUrl,
        buildable: inspection.buildable,
        ...(inspection.lastBuild ? { lastBuildNumber: inspection.lastBuild.number } : {}),
      },
    });
    return NextResponse.json(inspection);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
