import "server-only";

import type { RunBatchExportRow } from "@autoforge/application";
import {
  DEFAULT_PLATFORM_TIME_ZONE,
  type ExportOutcomeFilter,
  type RunBatchExportTemplate,
} from "@autoforge/contracts";
import type { FailureAnalysisCategory, FailureAnalysisClaim } from "@autoforge/domain";
import ExcelJS from "exceljs";
import {
  exportColumnWidth,
  EXPORT_WIDTH_SAMPLE_ROWS,
  exportWorksheetOptions,
  styleExportHeader,
  styleExportRow,
  styleExportResult,
  type ExportTone,
} from "./export-workbook-style";

/**
 * 执行结果导出 Excel 生成。列顺序即需求约定的固定顺序；
 * blocked 新口径下所有导出行都有 attempt（从未执行的用例不导出）。
 */

const LOG_LINK_COLUMN_WIDTH = { minimum: 64, maximum: 120 } as const;

const EXPORT_COLUMNS = [
  { header: "用例路径", minimum: 28, maximum: 52 },
  { header: "名称", minimum: 18, maximum: 36 },
  { header: "执行结果", minimum: 10, maximum: 18 },
  { header: "错误描述", minimum: 24, maximum: 52 },
  { header: "执行开始时间", minimum: 26, maximum: 26 },
  { header: "执行结束时间", minimum: 26, maximum: 26 },
  { header: "执行耗时(s)", minimum: 14, maximum: 16 },
  { header: "日志链接", ...LOG_LINK_COLUMN_WIDTH },
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
const FAILURE_ANALYSIS_COLUMN_WIDTHS = [32, 24, 36, 14, 18, 24, 24, 18, 20] as const;
const OUTCOME_LABELS: Record<ExportOutcomeFilter, string> = {
  succeeded: "成功",
  failed: "失败",
  timed_out: "超时",
  cancelled: "取消",
  blocked: "阻塞（异常结束）",
};

const OUTCOME_TONES: Record<ExportOutcomeFilter, ExportTone> = {
  succeeded: "success",
  failed: "error",
  timed_out: "warning",
  cancelled: "neutral",
  blocked: "neutral",
};

export type RunBatchExportWorkbookInput = {
  batchId: string;
  template?: RunBatchExportTemplate;
  scope: "round" | "final" | "all";
  /** scope=round 时记录具体轮次，用于文件名区分。 */
  round?: number;
  rows: readonly RunBatchExportRow[];
  /** 与页面一致的平台展示时区；未指定时使用北京时间。 */
  timeZone?: string;
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
  const sheet = workbook.addWorksheet("执行结果", exportWorksheetOptions());
  // all 口径同一用例可能有多条记录，首列标注轮次以便区分。
  const includeRound = input.scope === "all";
  const timestampFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timeZone ?? DEFAULT_PLATFORM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  const columns = includeRound
    ? [{ header: "轮次", minimum: 6, maximum: 8 }, ...EXPORT_COLUMNS]
    : EXPORT_COLUMNS;
  const cellsFor = (row: RunBatchExportRow): ExcelJS.CellValue[] => {
    const shareLink = row.attemptId ? input.shareLinks.get(row.attemptId) : undefined;
    return [
      ...(includeRound ? [row.round] : []),
      row.casePath,
      row.displayName,
      OUTCOME_LABELS[row.outcome],
      row.summary ?? "",
      formatExportTimestamp(row.startedAt, timestampFormatter),
      formatExportTimestamp(row.finishedAt, timestampFormatter),
      row.durationMs === null ? "" : Number((row.durationMs / 1_000).toFixed(1)),
      shareLink ? { text: shareLink, hyperlink: shareLink } : "",
    ];
  };
  const samples = input.rows.slice(0, EXPORT_WIDTH_SAMPLE_ROWS).map(cellsFor);
  sheet.columns = columns.map((column, index) => ({
    header: column.header,
    width: exportColumnWidth(
      column.header,
      samples.map((cells) => {
        const value = cells[index];
        return typeof value === "object" && value && "hyperlink" in value
          ? value.text
          : String(value ?? "");
      }),
      column,
    ),
  }));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  styleExportHeader(sheet.getRow(1));

  for (const row of input.rows) {
    const exportedRow = sheet.addRow(cellsFor(row));
    styleExportRow(exportedRow, columns.length);
    styleExportResult(exportedRow.getCell(includeRound ? 4 : 3), OUTCOME_TONES[row.outcome]);
    exportedRow.getCell(includeRound ? 8 : 7).numFmt = "0.0";
  }
}

function formatExportTimestamp(value: string | null, formatter: Intl.DateTimeFormat): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}

function buildFailureAnalysisSheet(
  workbook: ExcelJS.Workbook,
  input: RunBatchExportWorkbookInput,
): void {
  const sheet = workbook.addWorksheet("失败用例分析清单", exportWorksheetOptions(2));
  const logColumnIndex = FAILURE_ANALYSIS_HEADERS.length - 1;
  const logColumnWidth = exportColumnWidth(
    FAILURE_ANALYSIS_HEADERS[logColumnIndex]!,
    input.rows
      .slice(0, EXPORT_WIDTH_SAMPLE_ROWS)
      .map((row) => (row.attemptId ? (input.shareLinks.get(row.attemptId) ?? "") : "")),
    LOG_LINK_COLUMN_WIDTH,
  );
  sheet.columns = FAILURE_ANALYSIS_HEADERS.map((header, index) => ({
    header,
    width: index === logColumnIndex ? logColumnWidth : FAILURE_ANALYSIS_COLUMN_WIDTHS[index]!,
  }));
  sheet.autoFilter = { from: "A1", to: "J1" };
  styleExportHeader(sheet.getRow(1));

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
    styleFailureAnalysisRow(row, completedClaim?.category);
  }
}

function styleFailureAnalysisRow(
  row: ExcelJS.Row,
  category: FailureAnalysisCategory | undefined,
): void {
  styleExportRow(row, FAILURE_ANALYSIS_HEADERS.length);
  row.height = 20;
  row.getCell(2).font = { ...row.getCell(2).font, bold: true };
  row.getCell(4).alignment = { horizontal: "center", vertical: "middle" };
  const analysisResultCell = row.getCell(5);
  if (category)
    styleExportResult(
      analysisResultCell,
      category === "rerun_passed" ? "success" : category === "case_fixed" ? "info" : "warning",
    );
  analysisResultCell.dataValidation = {
    type: "list",
    allowBlank: true,
    showErrorMessage: true,
    errorStyle: "stop",
    errorTitle: "分析结果无效",
    error: "请从下拉列表中选择分析结果。",
    formulae: [`"${FAILURE_ANALYSIS_RESULTS.join(",")}"`],
  };
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
