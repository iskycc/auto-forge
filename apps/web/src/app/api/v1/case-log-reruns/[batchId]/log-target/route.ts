import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

/**
 * 手动单用例重跑不会出现在普通批次 API 中；该端点只返回打开实时日志所需的最小状态。
 */
export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const services = await getPlatformServices();
    const target = await services.runBatches.getCaseLogRerunLogTarget(batchId);
    services.identityAccess.authorize(identity, "log.read", target.projectId);
    return NextResponse.json({
      batchId,
      batchStatus: target.batchStatus,
      attempt: target.attempt,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
