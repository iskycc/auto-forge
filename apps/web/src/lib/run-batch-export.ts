import { EXPORT_OUTCOME_FILTERS, type ExportOutcomeFilter } from "@autoforge/contracts";

export type RunBatchExportScope = "round" | "final" | "all";

/** 导出弹窗中的结果筛选项；顺序即契约顺序，展示与 query 组装共用。 */
export const EXPORT_OUTCOME_OPTIONS: ReadonlyArray<{
  value: ExportOutcomeFilter;
  label: string;
}> = [
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "timed_out", label: "超时" },
  { value: "cancelled", label: "取消" },
  { value: "blocked", label: "阻塞（异常结束）" },
];

/** 默认勾选失败与阻塞：导出的主要诉求是分析未通过与非正常结束的用例。 */
export const DEFAULT_EXPORT_OUTCOMES: readonly ExportOutcomeFilter[] = ["failed", "blocked"];

/**
 * 组装 GET /api/v1/run-batches/[batchId]/export 的查询串。
 * outcomes 固定按契约顺序输出，与用户勾选先后无关，保证结果可测试、可分享。
 * 仅 scope=round 需要轮次号；final/all 忽略 round 参数。
 */
export function buildRunBatchExportQuery(
  scope: RunBatchExportScope,
  round: number | undefined,
  outcomes: readonly ExportOutcomeFilter[],
): string {
  const parameters = new URLSearchParams();
  parameters.set("scope", scope);
  if (scope === "round" && round !== undefined) parameters.set("round", String(round));
  const ordered = EXPORT_OUTCOME_FILTERS.filter((filter) => outcomes.includes(filter));
  parameters.set("outcomes", ordered.join(","));
  return parameters.toString();
}

export const EXPORT_FALLBACK_FILENAME = "run-batch-results.xlsx";

/** 从 Content-Disposition 解析下载文件名；缺失或无法解析时回退到固定文件名。 */
export function parseExportFilename(contentDisposition: string | null): string {
  if (!contentDisposition) return EXPORT_FALLBACK_FILENAME;
  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(contentDisposition);
  if (extended?.[1]) {
    try {
      const decoded = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
      if (decoded) return decoded;
    } catch {
      return EXPORT_FALLBACK_FILENAME;
    }
  }
  const basic = /filename="?([^";]+)"?/i.exec(contentDisposition);
  const name = basic?.[1]?.trim();
  return name || EXPORT_FALLBACK_FILENAME;
}
