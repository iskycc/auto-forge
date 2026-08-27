import { createRunBatchInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createRunBatchInputSchema.parse(await readJsonBody(request, 128 * 1024));
    const services = await getPlatformServices();
    const projectScope = services.identityAccess.projectScope(identity, "run.create");
    // 授权只需任务的归属项目；预检内部会按需读取完整任务快照。
    const suite = await services.caseSuites.getSummary(input.suiteId, projectScope);
    services.identityAccess.authorize(identity, "run.create", suite.projectId);
    return NextResponse.json(await services.runBatches.preflight(input));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
