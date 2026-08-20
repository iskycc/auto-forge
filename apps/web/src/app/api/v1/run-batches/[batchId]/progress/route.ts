import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { buildRunProgress } from "@/lib/run-progress";
import { verifyRunProgressToken } from "@/lib/run-progress-token";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { batchId } = await context.params;
    const services = await getPlatformServices();
    const accessToken = new URL(request.url).searchParams.get("access_token");
    let batch;
    if (accessToken) {
      if (!verifyRunProgressToken(services.config.masterKey, accessToken, batchId)) {
        throw new DomainError("RUN_PROGRESS_TOKEN_INVALID", "执行进度访问令牌无效或已过期。");
      }
      batch = await services.runBatches.get(batchId);
    } else {
      const identity = await authenticateRequest(request);
      const projectIds = services.identityAccess.projectScope(identity, "run.read");
      batch = await services.runBatches.get(batchId, projectIds);
      services.identityAccess.authorize(identity, "run.read", batch.projectId);
    }
    return NextResponse.json(buildRunProgress(batch), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
