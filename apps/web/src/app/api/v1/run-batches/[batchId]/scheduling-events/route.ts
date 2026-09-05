import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";

type Context = { params: Promise<{ batchId: string }> };

// 查询参数在入口校验：limit 有上限，避免无界查询。
const querySchema = z
  .object({
    runnerId: z.string().min(1).max(128).optional(),
    afterId: z.string().min(1).max(128).optional(),
    beforeId: z.string().min(1).max(128).optional(),
    latest: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .superRefine((query, context) => {
    if (query.afterId && (query.beforeId || query.latest === true)) {
      context.addIssue({
        code: "custom",
        message: "afterId 不能与 beforeId/latest 同时使用。",
      });
    }
  });

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    // 只读取批次摘要完成范围校验，不能为了鉴权加载数十万条 run/attempt。
    await services.runBatches.getMetadata(batchId, projectIds);
    const page = await services.runBatches.listSchedulingEvents(batchId, {
      limit: query.limit,
      ...(query.runnerId ? { runnerId: query.runnerId } : {}),
      ...(query.afterId ? { afterId: query.afterId } : {}),
      ...(query.beforeId ? { beforeId: query.beforeId } : {}),
      ...(query.latest !== undefined ? { latest: query.latest } : {}),
    });
    // nextAfterId 缺失时不输出 undefined 值，保持 JSON 形状稳定。
    return NextResponse.json({
      items: page.items,
      ...(page.nextAfterId !== undefined ? { nextAfterId: page.nextAfterId } : {}),
      ...(page.nextBeforeId !== undefined ? { nextBeforeId: page.nextBeforeId } : {}),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
