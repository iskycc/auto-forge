import { caseSuiteActivityScopeSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, authorizedProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const scope = caseSuiteActivityScopeSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    authorizedProjectScope(identity, "case_suite.read", scope.projectId);
    authorizedProjectScope(identity, "run.read", scope.projectId);
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    return NextResponse.json(await services.caseSuiteActivity.readRecentExecutions(suiteId, scope));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
