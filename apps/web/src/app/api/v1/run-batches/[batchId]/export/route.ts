import { EXPORT_OUTCOME_FILTERS, type ExportOutcomeFilter } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { publicLinkBase } from "@/lib/public-link-base";
import { buildRunBatchExportWorkbook, exportContentDisposition } from "@/lib/run-batch-export-xlsx";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

const exportQuerySchema = z.object({
  scope: z.enum(["round", "final", "all"]),
  round: z.coerce.number().int().min(1).optional(),
  outcomes: z.string().min(1),
});

export const dynamic = "force-dynamic";

/**
 * 导出批次执行结果为 Excel。附带为每个导出行的 attempt 生成日志公开访问链接；
 * blocked 新口径下从未执行的用例不导出，因此每行都有 attempt。
 */
export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const parsed = exportQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const outcomes = parseOutcomeFilter(parsed.outcomes);
    if (parsed.scope === "round" && parsed.round === undefined) {
      throw new DomainError("INVALID_ROUND", "按轮次导出时必须提供轮次号。");
    }
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    const rows = await services.runBatchExport.buildRows({
      batchId,
      scope: parsed.scope,
      ...(parsed.round !== undefined ? { round: parsed.round } : {}),
      outcomes,
      ...(projectIds ? { projectIds } : {}),
    });

    const attemptIds = rows.flatMap((row) => (row.attemptId ? [row.attemptId] : []));
    // 导出批次内全部 attempt 归属 batchId（buildRows 已校验批次存在），
    // 走批量路径避免 5 万行导出时的逐条链接查询。
    const tokens = await services.attemptLogShares.ensureSharesForAttemptsInBatch(
      attemptIds,
      batchId,
      identity.user.id,
    );
    const base = publicLinkBase(services.config.web.publicBaseUrl, request);
    const shareLinks = new Map(
      [...tokens.entries()].map(([attemptId, token]) => [
        attemptId,
        `${base}/share/attempt-log/${token}`,
      ]),
    );

    const { buffer, filename } = await buildRunBatchExportWorkbook({
      batchId,
      scope: parsed.scope,
      ...(parsed.round !== undefined ? { round: parsed.round } : {}),
      rows,
      shareLinks,
    });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": exportContentDisposition(filename),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function parseOutcomeFilter(raw: string): ExportOutcomeFilter[] {
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => !(EXPORT_OUTCOME_FILTERS as readonly string[]).includes(value))) {
    throw new DomainError("INVALID_OUTCOMES", "导出结果筛选包含不支持的选项。");
  }
  // 按契约固定顺序去重，保证相同筛选的请求得到相同结果。
  return EXPORT_OUTCOME_FILTERS.filter((filter) => values.includes(filter));
}
