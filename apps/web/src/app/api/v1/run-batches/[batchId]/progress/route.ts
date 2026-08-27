import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { buildRunProgressFromOverview } from "@/lib/run-progress";
import { verifyRunProgressToken } from "@/lib/run-progress-token";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { batchId } = await context.params;
    const services = await getPlatformServices();
    const accessToken = new URL(request.url).searchParams.get("access_token");
    let overview;
    if (accessToken) {
      const validTemporaryToken = verifyRunProgressToken(
        services.config.masterKey,
        accessToken,
        batchId,
      );
      const permanentBatchId = readPermanentShareToken(
        services.config.masterKey,
        accessToken,
        "run_batch",
      );
      if (!validTemporaryToken && permanentBatchId !== batchId) {
        throw new DomainError("RUN_PROGRESS_TOKEN_INVALID", "执行进度访问令牌无效或已过期。");
      }
      overview = await services.runBatches.getDetailOverview(batchId);
    } else {
      const identity = await authenticateRequest(request);
      const projectIds = services.identityAccess.projectScope(identity, "run.read");
      overview = await services.runBatches.getDetailOverview(batchId, projectIds);
      services.identityAccess.authorize(identity, "run.read", overview.batch.projectId);
    }
    return NextResponse.json(buildRunProgressFromOverview(overview), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
