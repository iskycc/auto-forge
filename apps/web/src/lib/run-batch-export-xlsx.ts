import "server-only";

import type { RunBatchExportRow } from "@autoforge/application";
import {
  DEFAULT_PLATFORM_TIME_ZONE,
  EXPORT_ISSUE_PREVIEW_LIMIT,
  type ExportValidationReport,
  type ExportOutcomeFilter,
  type RunBatchExportTemplate,
} from "@autoforge/contracts";
import {
  DomainError,
  type FailureAnalysisCategory,
  type FailureAnalysisClaim,
} from "@autoforge/domain";
import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import {
  exportColumnWidth,
  EXPORT_WIDTH_SAMPLE_ROWS,
  exportWorksheetOptions,
  styleExportHeader,
  styleExportRow,
  styleExportResult,
  type ExportTone,
} from "./export-workbook-style";
import {
  EXCEL_SHEET_HYPERLINK_LIMIT,
  EXCEL_SHEET_ROW_LIMIT,
  exportRowHyperlinkCount,
  validateExportCells,
} from "./export-cell-validation";

/**
 * 执行结果导出 Excel 生成。列顺序即需求约定的固定顺序；
 * blocked 新口径下所有导出行都有 attempt（从未执行的用例不导出）。
 */

const LOG_LINK_COLUMN_WIDTH = { minimum: 64, maximum: 120 } as const;
const DDT_EXPORT_COLUMNS = [
  { header: "CaseName", group: "metadata", minimum: 18, maximum: 36 },
  { header: "SRID", group: "metadata", minimum: 16, maximum: 32 },
] as const;

const EXPORT_COLUMNS = [
  { header: "用例路径", group: "identity", minimum: 28, maximum: 52 },
  { header: "名称", group: "identity", minimum: 18, maximum: 36 },
  { header: "执行结果", group: "result", minimum: 10, maximum: 18 },
  { header: "错误描述", group: "result", minimum: 24, maximum: 52 },
  { header: "执行开始时间", group: "time", minimum: 26, maximum: 26 },
  { header: "执行结束时间", group: "time", minimum: 26, maximum: 26 },
  { header: "执行耗时(s)", group: "time", minimum: 14, maximum: 16 },
  { header: "日志链接", group: "link", ...LOG_LINK_COLUMN_WIDTH },
] as const;

const FAILURE_ANALYSIS_COLUMNS = [
  { header: "用例编号", group: "identity" },
  { header: "用例名称", group: "identity" },
  { header: "失败堆栈", group: "result" },
  { header: "分析责任人", group: "analysis" },
  { header: "分析结果", group: "analysis" },
  { header: "问题根因", group: "analysis" },
  { header: "问题单号或用例修改证明", group: "evidence" },
  { header: "重跑通过截图", group: "evidence" },
  { header: "备注", group: "analysis" },
  { header: "用例日志链接", group: "link" },
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
  /** Determined from the whole batch before reading filtered pages. */
  includesDdt?: boolean;
  /** scope=round 时记录具体轮次。 */
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
): Promise<{ buffer: Buffer }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AutoForge";
  const rows = exportWorkbookRows(workbook, input);
  for (const row of input.rows) rows.append(input, row);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { buffer };
}

/** Consume one bounded page at a time; committed rows and hyperlinks are released by the writer. */
export async function createRunBatchExportWorkbookStream(
  pages: AsyncIterable<RunBatchExportWorkbookInput>,
  signal: AbortSignal,
  options: { invalidRows?: "reject" | "exclude" } = {},
): Promise<{
  stream: PassThrough;
  validation: ExportValidationReport;
  completed: Promise<Error | undefined>;
}> {
  const iterator = pages[Symbol.asyncIterator]();
  const loadFirstPage = async () => {
    try {
      signal.throwIfAborted();
      const first = await iterator.next();
      if (first.done)
        throw new Error("Export requires an initial page, even when there are no results.");
      signal.throwIfAborted();
      return first;
    } catch (cause) {
      await iterator.return?.();
      throw cause;
    }
  };
  const first = await loadFirstPage();
  const input = first.value;
  const validation = emptyExportValidationReport();
  const stream = new PassThrough({ highWaterMark: 256 * 1024 });
  const controller = new AbortController();
  const abort = () => {
    controller.abort(signal.reason ?? new Error("执行结果导出已取消。"));
    stream.destroy(controller.signal.reason as Error);
  };
  signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () => controller.abort(new Error("导出下载连接已关闭。")));
  const write = async () => {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream,
      useStyles: true,
      useSharedStrings: false,
    });
    workbook.creator = "AutoForge";
    const rows = exportWorkbookRows(workbook, input, {
      invalidRows: options.invalidRows ?? "reject",
      validation,
      commitRow: (row) => row.commit(),
      commitSheet: (sheet) => sheet.commit(),
    });
    let page: IteratorResult<RunBatchExportWorkbookInput, unknown> = first;
    while (!page.done) {
      controller.signal.throwIfAborted();
      // Yield every 25 rows, including within a page of long failure descriptions.
      for (let offset = 0; offset < page.value.rows.length; offset += 25) {
        for (const row of page.value.rows.slice(offset, offset + 25)) rows.append(page.value, row);
        await setImmediate(undefined, { signal: controller.signal });
        if (stream.writableNeedDrain) await once(stream, "drain", { signal: controller.signal });
      }
      await setImmediate(undefined, { signal: controller.signal });
      controller.signal.throwIfAborted();
      page = await iterator.next();
    }
    rows.finish();
    await workbook.commit();
  };
  const completed = (async (): Promise<Error | undefined> => {
    const failures: unknown[] = [];
    try {
      await write();
    } catch (cause) {
      failures.push(cause);
    }
    signal.removeEventListener("abort", abort);
    try {
      await iterator.return?.();
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length === 0) return undefined;
    const cause =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "导出生成和分页清理失败。");
    const failure = cause instanceof Error ? cause : new Error("执行结果导出失败。", { cause });
    stream.destroy(failure);
    return failure;
  })();
  return {
    stream,
    validation,
    completed,
  };
}

function buildExecutionResultsSheet(
  workbook: Pick<ExcelJS.Workbook, "addWorksheet">,
  input: RunBatchExportWorkbookInput,
  name = "执行结果",
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, exportWorksheetOptions());
  // all 口径同一用例可能有多条记录，首列标注轮次以便区分。
  const includeRound = input.scope === "all";
  const timestampFormatter = exportTimestampFormatter(input);
  const columns = [
    ...(includeRound
      ? [{ header: "轮次", group: "neutral" as const, minimum: 6, maximum: 8 }]
      : []),
    ...EXPORT_COLUMNS.slice(0, 2),
    ...(input.includesDdt ? DDT_EXPORT_COLUMNS : []),
    ...EXPORT_COLUMNS.slice(2),
  ];
  const cellsFor = (row: RunBatchExportRow) => executionResultCells(row, input, timestampFormatter);
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
  styleExportHeader(
    sheet.getRow(1),
    columns.map((column) => column.group),
  );

  return sheet;
}

function exportTimestampFormatter(input: RunBatchExportWorkbookInput) {
  return new Intl.DateTimeFormat("en-CA", {
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
}

function executionResultCells(
  row: RunBatchExportRow,
  input: RunBatchExportWorkbookInput,
  timestampFormatter: Intl.DateTimeFormat,
): ExcelJS.CellValue[] {
  const includeRound = input.scope === "all";
  const shareLink = row.attemptId ? input.shareLinks.get(row.attemptId) : undefined;
  return [
    ...(includeRound ? [row.round] : []),
    row.casePath,
    row.displayName,
    ...ddtExportCells(row, input),
    OUTCOME_LABELS[row.outcome],
    row.summary ?? "",
    formatExportTimestamp(row.startedAt, timestampFormatter),
    formatExportTimestamp(row.finishedAt, timestampFormatter),
    row.durationMs === null ? "" : Number((row.durationMs / 1_000).toFixed(1)),
    shareLink ? { text: shareLink, hyperlink: shareLink } : "",
  ];
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
  workbook: Pick<ExcelJS.Workbook, "addWorksheet">,
  input: RunBatchExportWorkbookInput,
  name = "失败用例分析清单",
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, exportWorksheetOptions(2));
  const columns = exportColumns(input);
  const headers = columns.map((column) => column.header);
  const logColumnIndex = headers.length - 1;
  const logColumnWidth = exportColumnWidth(
    headers[logColumnIndex]!,
    input.rows
      .slice(0, EXPORT_WIDTH_SAMPLE_ROWS)
      .map((row) => (row.attemptId ? (input.shareLinks.get(row.attemptId) ?? "") : "")),
    LOG_LINK_COLUMN_WIDTH,
  );
  const widths = [
    ...FAILURE_ANALYSIS_COLUMN_WIDTHS.slice(0, 2),
    ...(input.includesDdt
      ? DDT_EXPORT_COLUMNS.map((column) =>
          exportColumnWidth(
            column.header,
            input.rows
              .slice(0, EXPORT_WIDTH_SAMPLE_ROWS)
              .map((row) =>
                String((column.header === "CaseName" ? row.ddt?.caseName : row.ddt?.srId) ?? ""),
              ),
            column,
          ),
        )
      : []),
    ...FAILURE_ANALYSIS_COLUMN_WIDTHS.slice(2),
  ];
  sheet.columns = headers.map((header, index) => ({
    header,
    width: index === logColumnIndex ? logColumnWidth : widths[index]!,
  }));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  styleExportHeader(
    sheet.getRow(1),
    columns.map((column) => column.group),
  );

  return sheet;
}

function failureAnalysisCells(
  item: RunBatchExportRow,
  input: RunBatchExportWorkbookInput,
): ExcelJS.CellValue[] {
  const shareLink = item.attemptId ? input.shareLinks.get(item.attemptId) : undefined;
  const claim = item.attemptId ? input.analysisClaims?.get(item.attemptId) : undefined;
  const completedClaim = claim?.status === "completed" ? claim : undefined;
  const proofLink =
    completedClaim?.category === "rerun_passed"
      ? input.analysisProofLinks?.get(completedClaim.id)
      : undefined;
  return [
    // 产品口径：用例编号就是用例类路径，不是平台 UUID。
    item.casePath,
    item.displayName,
    ...ddtExportCells(item, input),
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
  ];
}

function ddtExportCells(
  row: RunBatchExportRow,
  input: RunBatchExportWorkbookInput,
): ExcelJS.CellValue[] {
  return input.includesDdt ? [row.ddt?.caseName ?? "", row.ddt?.srId ?? ""] : [];
}

function emptyExportValidationReport(): ExportValidationReport {
  return {
    schemaVersion: 1,
    totalRows: 0,
    validRows: 0,
    excludedRows: 0,
    issues: [],
    truncated: false,
  };
}

function exportHeaders(
  input: Pick<RunBatchExportWorkbookInput, "template" | "scope" | "includesDdt">,
): readonly string[] {
  return exportColumns(input).map((column) => column.header);
}

function exportColumns(
  input: Pick<RunBatchExportWorkbookInput, "template" | "scope" | "includesDdt">,
) {
  const columns = input.template === "failure-analysis" ? FAILURE_ANALYSIS_COLUMNS : EXPORT_COLUMNS;
  return [
    ...(input.template !== "failure-analysis" && input.scope === "all"
      ? [{ header: "轮次", group: "neutral" as const }]
      : []),
    ...columns.slice(0, 2),
    ...(input.includesDdt ? DDT_EXPORT_COLUMNS : []),
    ...columns.slice(2),
  ];
}

function exportCells(
  input: RunBatchExportWorkbookInput,
  row: RunBatchExportRow,
  formatter: Intl.DateTimeFormat,
): ExcelJS.CellValue[] {
  return input.template === "failure-analysis"
    ? failureAnalysisCells(row, input)
    : executionResultCells(row, input, formatter);
}

/** Only compatible rows receive public log grants; the writer records the full exclusion report. */
export async function exportCompatibleAttemptIds(
  input: RunBatchExportWorkbookInput,
  signal: AbortSignal,
): Promise<string[]> {
  const formatter = exportTimestampFormatter(input);
  const headers = exportHeaders(input);
  const ids: string[] = [];
  for (let offset = 0; offset < input.rows.length; offset++) {
    signal.throwIfAborted();
    const row = input.rows[offset]!;
    if (
      row.attemptId &&
      !validateExportCells(exportCells(input, row, formatter), headers, row, offset + 2)
    )
      ids.push(row.attemptId);
    if (offset % 25 === 24) await setImmediate(undefined, { signal });
  }
  return ids;
}

function exportWorkbookRows(
  workbook: Pick<ExcelJS.Workbook, "addWorksheet">,
  initial: RunBatchExportWorkbookInput,
  options: {
    invalidRows?: "reject" | "exclude";
    validation?: ExportValidationReport;
    commitRow?: (row: ExcelJS.Row) => void;
    commitSheet?: (sheet: ExcelJS.Worksheet) => void;
  } = {},
) {
  const validation = options.validation ?? emptyExportValidationReport();
  const headers = exportHeaders(initial);
  const formatter = exportTimestampFormatter(initial);
  let sheetNumber = 0;
  let hyperlinks = 0;
  let rowCount = 1;
  const createSheet = () => {
    sheetNumber++;
    hyperlinks = 0;
    rowCount = 1;
    const base = initial.template === "failure-analysis" ? "失败用例分析清单" : "执行结果";
    const name = sheetNumber === 1 ? base : `${base} (${sheetNumber})`;
    const sheet =
      initial.template === "failure-analysis"
        ? buildFailureAnalysisSheet(workbook, initial, name)
        : buildExecutionResultsSheet(workbook, initial, name);
    options.commitRow?.(sheet.getRow(1));
    return sheet;
  };
  let sheet = createSheet();
  let issueSheet: ExcelJS.Worksheet | undefined;
  let issueSheetNumber = 0;
  let issueRowCount = 1;
  const appendIssue = (issue: NonNullable<ReturnType<typeof validateExportCells>>) => {
    if (!issueSheet || issueRowCount === EXCEL_SHEET_ROW_LIMIT) {
      if (issueSheet) options.commitSheet?.(issueSheet);
      issueSheetNumber++;
      issueRowCount = 1;
      issueSheet = workbook.addWorksheet(
        issueSheetNumber === 1 ? "排除明细" : `排除明细 (${issueSheetNumber})`,
        exportWorksheetOptions(1),
      );
      issueSheet.columns = [
        { header: "原导出行", width: 12 },
        { header: "执行任务 ID", width: 38 },
        { header: "执行尝试 ID", width: 38 },
        { header: "轮次", width: 8 },
        { header: "用例路径", width: 52 },
        { header: "用例名称", width: 32 },
        { header: "字段与问题", width: 88 },
      ];
      issueSheet.autoFilter = { from: "A1", to: "G1" };
      styleExportHeader(issueSheet.getRow(1), [
        "neutral",
        "identity",
        "identity",
        "neutral",
        "identity",
        "identity",
        "result",
      ]);
      options.commitRow?.(issueSheet.getRow(1));
    }
    const excluded = issueSheet.addRow([
      issue.rowNumber,
      issue.executionRunId,
      issue.attemptId ?? "",
      issue.round,
      issue.casePath,
      issue.caseName,
      issue.fields.map(({ field, reason }) => `${field}：${reason}`).join("；"),
    ]);
    styleExportRow(excluded, 7);
    options.commitRow?.(excluded);
    issueRowCount++;
  };
  return {
    append(input: RunBatchExportWorkbookInput, source: RunBatchExportRow) {
      validation.totalRows++;
      const cells = exportCells(input, source, formatter);
      const issue = validateExportCells(cells, headers, source, validation.totalRows + 1);
      if (issue) {
        validation.excludedRows++;
        if (validation.issues.length < EXPORT_ISSUE_PREVIEW_LIMIT) validation.issues.push(issue);
        validation.truncated = validation.excludedRows > validation.issues.length;
        if (options.invalidRows !== "exclude")
          throw new DomainError(
            "EXPORT_DATA_INVALID",
            "部分记录无法安全写入 Excel，请排除异常数据后重试。",
            { details: validation },
          );
        appendIssue(issue);
        return;
      }
      const links = exportRowHyperlinkCount(cells);
      if (rowCount === EXCEL_SHEET_ROW_LIMIT || hyperlinks + links > EXCEL_SHEET_HYPERLINK_LIMIT) {
        options.commitSheet?.(sheet);
        sheet = createSheet();
      }
      const row = sheet.addRow(cells);
      if (initial.template === "failure-analysis") {
        const claim = source.attemptId ? input.analysisClaims?.get(source.attemptId) : undefined;
        styleFailureAnalysisRow(
          row,
          claim?.status === "completed" ? claim.category : undefined,
          headers,
        );
      } else {
        styleExportRow(row, headers.length);
        styleExportResult(
          row.getCell(headers.indexOf("执行结果") + 1),
          OUTCOME_TONES[source.outcome],
        );
        row.getCell(headers.indexOf("执行耗时(s)") + 1).numFmt = "0.0";
      }
      options.commitRow?.(row);
      hyperlinks += links;
      rowCount++;
      validation.validRows++;
    },
    finish() {
      options.commitSheet?.(sheet);
      if (issueSheet) options.commitSheet?.(issueSheet);
    },
  };
}

function styleFailureAnalysisRow(
  row: ExcelJS.Row,
  category: FailureAnalysisCategory | undefined,
  headers: readonly string[],
): void {
  styleExportRow(row, headers.length);
  row.height = 20;
  row.getCell(2).font = { ...row.getCell(2).font, bold: true };
  row.getCell(headers.indexOf("分析责任人") + 1).alignment = {
    horizontal: "center",
    vertical: "middle",
  };
  const analysisResultCell = row.getCell(headers.indexOf("分析结果") + 1);
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
