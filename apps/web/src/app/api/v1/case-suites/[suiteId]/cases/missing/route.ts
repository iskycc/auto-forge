import { updateCaseSuiteItemsInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

/**
 * 返回候选集合中尚未加入任务的用例。使用 POST 是为了支持 10 万级候选 ID，
 * 避免把大列表放入 URL；该端点只读，不修改任务版本。
 */
export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = updateCaseSuiteItemsInputSchema.parse(
      await readJsonBody(request, 16 * 1_024 * 1_024),
    );
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.manage");
    const caseDefinitionIds = await services.caseSuites.missingCaseIds(
      suiteId,
      input.caseDefinitionIds,
      projectIds,
    );
    return NextResponse.json({ caseDefinitionIds });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
