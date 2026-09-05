import { readReadyModel } from "@/lib/read-ready-model";
import { DomainError } from "@autoforge/domain";
import { failureAnalysisStatisticsPageSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  projectVersionId: z.string().min(1).optional(),
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    await authorizeRequest(request, "audit.read", input.projectId);
    const services = await getPlatformServices();
    const batch = await readReadyModel(
      services.readModels,
      {
        kind: "analysis_batch",
        projectId: input.projectId,
        batchId: input.batchId,
        ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      },
      request.signal,
    );
    if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "分析任务不存在。");
    const page = await readReadyModel(
      services.readModels,
      {
        kind: "analysis_statistics",
        projectId: input.projectId,
        batchId: input.batchId,
        limit: input.limit,
        ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      request.signal,
    );
    return NextResponse.json(failureAnalysisStatisticsPageSchema.parse(page), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
