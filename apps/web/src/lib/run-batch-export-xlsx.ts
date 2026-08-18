import "server-only";

import type { RunBatchExportRow } from "@autoforge/application";
import type { ExportOutcomeFilter } from "@autoforge/contracts";
import ExcelJS from "exceljs";

/**
 * 执行结果导出 Excel 生成。列顺序即需求约定的固定顺序；
 * blocked 行没有 attempt，时间/耗时为空，日志链接留空。
 */

const EXPORT_HEADERS = [
  "用例路径",
  "名称",
  "执行结果",
  "错误描述",
  "执行开始时间",
  "执行结束时间",
  "执行耗时(s)",
  "日志链接",
] as const;

const OUTCOME_LABELS: Record<ExportOutcomeFilter, string> = {
  succeeded: "成功",
  failed: "失败",
  timed_out: "超时",
  cancelled: "取消",
  blocked: "阻塞",
};

export type RunBatchExportWorkbookInput = {
  batchId: string;
  scope: "round" | "final";
  /** scope=round 时记录具体轮次，用于文件名区分。 */
  round?: number;
  rows: readonly RunBatchExportRow[];
  /** attemptId -> 日志公开访问链接绝对地址。 */
  shareLinks: ReadonlyMap<string, string>;
};

export async function buildRunBatchExportWorkbook(
  input: RunBatchExportWorkbookInput,
): Promise<{ buffer: Buffer; filename: string }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AutoForge";
  const sheet = workbook.addWorksheet("执行结果", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = EXPORT_HEADERS.map((header) => ({ header, width: headerWidth(header) }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };

  for (const row of input.rows) {
    const shareLink = row.attemptId ? input.shareLinks.get(row.attemptId) : undefined;
    const cells: ExcelJS.CellValue[] = [
      row.casePath,
      row.displayName,
      OUTCOME_LABELS[row.outcome],
      row.summary ?? "",
      row.startedAt ?? "",
      row.finishedAt ?? "",
      row.durationMs === null ? "" : Number((row.durationMs / 1_000).toFixed(1)),
      shareLink ? { text: shareLink, hyperlink: shareLink } : "",
    ];
    sheet.addRow(cells);
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { buffer, filename: exportFilename(input.batchId, input.scope, input.round) };
}

function headerWidth(header: string): number {
  if (header === "用例路径" || header === "日志链接") return 48;
  if (header === "错误描述") return 60;
  if (header === "名称") return 32;
  return 20;
}

function exportFilename(batchId: string, scope: "round" | "final", round?: number): string {
  const suffix = scope === "round" ? `round-${round ?? 0}` : "final";
  return `run-batch-${batchId.slice(0, 8)}-${suffix}.xlsx`;
}

/** Content-Disposition 需 RFC 5987 编码，保证中文文件名可被浏览器正确解码。 */
export function exportContentDisposition(filename: string): string {
  return `attachment; filename="run-batch-export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
