import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { toExecutionBatchView } from "@/lib/execution-batch-view";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

const querySchema = z.object({ access_token: z.string().min(1).optional() });

/** 有界的批次实时概要；不会读取或序列化整批 ExecutionRun/RunAttempt。 */
export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { batchId } = await context.params;
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    let projectIds: readonly string[] | undefined;
    if (input.access_token) {
      const sharedBatchId = readPermanentShareToken(
        services.config.masterKey,
        input.access_token,
        "run_batch",
      );
      if (sharedBatchId !== batchId) {
        throw new DomainError("RUN_BATCH_SHARE_TOKEN_INVALID", "执行详情永久分享链接无效。");
      }
    } else {
      const identity = await authenticateRequest(request);
      projectIds = services.identityAccess.projectScope(identity, "run.read");
    }
    const overview = await services.runBatches.getDetailOverview(batchId, projectIds);
    return NextResponse.json(toExecutionBatchView(overview), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
