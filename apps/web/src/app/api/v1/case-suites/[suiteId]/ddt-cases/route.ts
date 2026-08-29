import {
  addCaseSuiteDdtItemsInputSchema,
  removeCaseSuiteDdtItemsInputSchema,
} from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  return updateDdtItems(request, context, "add");
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  return updateDdtItems(request, context, "remove");
}

async function updateDdtItems(
  request: Request,
  context: Context,
  operation: "add" | "remove",
): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const body = await readJsonBody(request, 16 * 1_024 * 1_024);
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    let suite: CaseSuite;
    let caseCount: number;
    let testStageId: string | undefined;
    if (operation === "add") {
      const input = addCaseSuiteDdtItemsInputSchema.parse(body);
      suite = await services.caseSuites.addDdtCases(
        suiteId,
        input.testStageId,
        input.caseIds,
        identity.user.id,
        projectIds,
      );
      caseCount = input.caseIds.length;
      testStageId = input.testStageId;
    } else {
      const input = removeCaseSuiteDdtItemsInputSchema.parse(body);
      suite = await services.caseSuites.removeDdtCases(
        suiteId,
        input.ddtCaseIds,
        identity.user.id,
        projectIds,
      );
      caseCount = input.ddtCaseIds.length;
    }
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: operation === "add" ? "case_suite.add_ddt_cases" : "case_suite.remove_ddt_cases",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: currentRequestId,
      details: {
        caseCount,
        ...(testStageId ? { testStageId } : {}),
      },
    });
    return NextResponse.json(suite);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
