import "server-only";

import type { RunBatchExportRow } from "@autoforge/application";
import type { ExportOutcomeFilter, RunBatchExportTemplate } from "@autoforge/contracts";
import type { FailureAnalysisCategory, FailureAnalysisClaim } from "@autoforge/domain";
import ExcelJS from "exceljs";

/**
 * 执行结果导出 Excel 生成。列顺序即需求约定的固定顺序；
 * blocked 新口径下所有导出行都有 attempt（从未执行的用例不导出）。
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

const FAILURE_ANALYSIS_HEADERS = [
  "用例编号",
  "用例名称",
  "失败堆栈",
  "分析责任人",
  "分析结果",
  "问题根因",
  "问题单号或用例修改证明",
  "重跑通过截图",
  "备注",
  "用例日志链接",
] as const;

export const FAILURE_ANALYSIS_RESULTS = ["重跑通过", "用例问题已修改", "代码问题已提单"] as const;

const FAILURE_ANALYSIS_RESULT_LABELS: Record<FailureAnalysisCategory, string> = {
  rerun_passed: "重跑通过",
  case_fixed: "用例问题已修改",
  code_issue_filed: "代码问题已提单",
};

// 分析清单常有数百条失败记录，优先保证纵向浏览密度。长类名、堆栈和说明保留
// 完整单元格值，但不通过超宽列或多行行高强制展示全部内容。
const FAILURE_ANALYSIS_COLUMN_WIDTHS = [32, 24, 36, 14, 18, 24, 24, 18, 20, 32] as const;
const ANALYSIS_INPUT_FIRST_COLUMN = 4;
const ANALYSIS_INPUT_LAST_COLUMN = 9;

const OUTCOME_LABELS: Record<ExportOutcomeFilter, string> = {
  succeeded: "成功",
  failed: "失败",
  timed_out: "超时",
  cancelled: "取消",
  blocked: "阻塞（异常结束）",
};

export type RunBatchExportWorkbookInput = {
  batchId: string;
  template?: RunBatchExportTemplate;
  scope: "round" | "final" | "all";
  /** scope=round 时记录具体轮次，用于文件名区分。 */
  round?: number;
  rows: readonly RunBatchExportRow[];
  /** attemptId -> 日志公开访问链接绝对地址。 */
  shareLinks: ReadonlyMap<string, string>;
  /** 最终失败 attemptId -> 已持久化的分析记录；未认领用例不在映射中。 */
  analysisClaims?: ReadonlyMap<string, FailureAnalysisClaim>;
  /** analysisId -> 重跑公开日志或已上传截图的可访问地址。 */
  analysisProofLinks?: ReadonlyMap<string, string>;
};

export async function buildRunBatchExportWorkbook(
  input: RunBatchExportWorkbookInput,
): Promise<{ buffer: Buffer; filename: string }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AutoForge";
  if (input.template === "failure-analysis") {
    buildFailureAnalysisSheet(workbook, input);
  } else {
    buildExecutionResultsSheet(workbook, input);
  }
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    buffer,
    filename: exportFilename(input.batchId, input.scope, input.round, input.template ?? "results"),
  };
}

function buildExecutionResultsSheet(
  workbook: ExcelJS.Workbook,
  input: RunBatchExportWorkbookInput,
): void {
  const sheet = workbook.addWorksheet("执行结果", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  // all 口径同一用例可能有多条记录，首列标注轮次以便区分。
  const includeRound = input.scope === "all";
  const headers: readonly string[] = includeRound ? ["轮次", ...EXPORT_HEADERS] : EXPORT_HEADERS;
  sheet.columns = headers.map((header) => ({ header, width: headerWidth(header) }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };

  for (const row of input.rows) {
    const shareLink = row.attemptId ? input.shareLinks.get(row.attemptId) : undefined;
    const cells: ExcelJS.CellValue[] = [
      ...(includeRound ? [row.round] : []),
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
}

function buildFailureAnalysisSheet(
  workbook: ExcelJS.Workbook,
  input: RunBatchExportWorkbookInput,
): void {
  const sheet = workbook.addWorksheet("失败用例分析清单", {
    views: [{ state: "frozen", xSplit: 2, ySplit: 1 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.columns = FAILURE_ANALYSIS_HEADERS.map((header, index) => ({
    header,
    width: FAILURE_ANALYSIS_COLUMN_WIDTHS[index]!,
  }));
  sheet.autoFilter = { from: "A1", to: "J1" };
  styleFailureAnalysisHeader(sheet.getRow(1));

  for (const item of input.rows) {
    const shareLink = item.attemptId ? input.shareLinks.get(item.attemptId) : undefined;
    const claim = item.attemptId ? input.analysisClaims?.get(item.attemptId) : undefined;
    const completedClaim = claim?.status === "completed" ? claim : undefined;
    const proofLink =
      completedClaim?.category === "rerun_passed"
        ? input.analysisProofLinks?.get(completedClaim.id)
        : undefined;
    const row = sheet.addRow([
      // 产品口径：用例编号就是用例类路径，不是平台 UUID。
      item.casePath,
      item.displayName,
      item.summary ?? "",
      claim ? analystLabel(claim) : "",
      completedClaim?.category ? FAILURE_ANALYSIS_RESULT_LABELS[completedClaim.category] : "",
      completedClaim?.category === "case_fixed" || completedClaim?.category === "code_issue_filed"
        ? (completedClaim.issueDescription ?? "")
        : "",
      completedClaim ? issueEvidenceCell(completedClaim) : "",
      proofLink
        ? {
            text: completedClaim?.rerunProofUrl
              ? "重跑通过日志"
              : (completedClaim?.screenshot?.fileName ?? "重跑通过截图"),
            hyperlink: proofLink,
          }
        : "",
      completedClaim?.remark ?? "",
      shareLink ? { text: shareLink, hyperlink: shareLink } : "",
    ]);
    styleFailureAnalysisRow(row);
  }
}

function styleFailureAnalysisHeader(row: ExcelJS.Row): void {
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF315B7D" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFD1D9E0" } },
      left: { style: "thin", color: { argb: "FFD1D9E0" } },
      right: { style: "thin", color: { argb: "FFD1D9E0" } },
      top: { style: "thin", color: { argb: "FFD1D9E0" } },
    };
  });
}

function styleFailureAnalysisRow(row: ExcelJS.Row): void {
  row.height = 20;
  row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    cell.alignment = { vertical: "middle", wrapText: false };
    cell.border = { bottom: { style: "hair", color: { argb: "FFD9E1E8" } } };
    if (columnNumber >= ANALYSIS_INPUT_FIRST_COLUMN && columnNumber <= ANALYSIS_INPUT_LAST_COLUMN) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF8E8" } };
    }
  });
  const analysisResultCell = row.getCell(5);
  analysisResultCell.dataValidation = {
    type: "list",
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: "stop",
    errorTitle: "分析结果无效",
    error: "请从下拉列表中选择分析结果。",
    formulae: [`"${FAILURE_ANALYSIS_RESULTS.join(",")}"`],
  };
  for (const columnNumber of [7, 8, 10]) {
    const cell = row.getCell(columnNumber);
    if (typeof cell.value === "object" && cell.value && "hyperlink" in cell.value) {
      cell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
  }
}

function analystLabel(claim: FailureAnalysisClaim): string {
  const displayName = claim.claimantDisplayName.trim();
  const username = claim.claimantUsername.trim();
  if (!displayName) return username;
  if (!username || displayName === username) return displayName;
  return `${displayName}（${username}）`;
}

function issueEvidenceCell(claim: FailureAnalysisClaim): ExcelJS.CellValue {
  const value =
    claim.category === "case_fixed"
      ? claim.caseFixEvidence
      : claim.category === "code_issue_filed"
        ? claim.ticketReference
        : undefined;
  if (!value) return "";
  return /^https?:\/\/[^\s]+$/iu.test(value) ? { text: value, hyperlink: value } : value;
}

function headerWidth(header: string): number {
  if (header === "用例路径" || header === "日志链接") return 48;
  if (header === "错误描述") return 60;
  if (header === "名称") return 32;
  if (header === "轮次") return 10;
  return 20;
}

function exportFilename(
  batchId: string,
  scope: "round" | "final" | "all",
  round: number | undefined,
  template: RunBatchExportTemplate,
): string {
  const suffix =
    scope === "round" ? `round-${round ?? 0}` : scope === "all" ? "all-rounds" : "final";
  const templateSuffix = template === "failure-analysis" ? "failure-analysis-" : "";
  return `run-batch-${batchId.slice(0, 8)}-${templateSuffix}${suffix}.xlsx`;
}

/** Content-Disposition 需 RFC 5987 编码，保证中文文件名可被浏览器正确解码。 */
export function exportContentDisposition(filename: string): string {
  return `attachment; filename="run-batch-export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
