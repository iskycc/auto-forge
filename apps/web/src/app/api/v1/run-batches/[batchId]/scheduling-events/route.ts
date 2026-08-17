import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";

type Context = { params: Promise<{ batchId: string }> };

// 查询参数在入口校验：limit 有上限，避免无界查询。
const querySchema = z.object({
  runnerId: z.string().min(1).max(128).optional(),
  afterId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    // get 会校验批次存在性并过滤项目范围；随后读取事件。
    await services.runBatches.get(batchId, projectIds);
    const page = await services.runBatches.listSchedulingEvents(batchId, {
      limit: query.limit,
      ...(query.runnerId ? { runnerId: query.runnerId } : {}),
      ...(query.afterId ? { afterId: query.afterId } : {}),
    });
    // nextAfterId 缺失时不输出 undefined 值，保持 JSON 形状稳定。
    return NextResponse.json({
      items: page.items,
      ...(page.nextAfterId !== undefined ? { nextAfterId: page.nextAfterId } : {}),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
