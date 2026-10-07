import "server-only";

import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { PassThrough } from "node:stream";
import type { ExecutionException, ExecutionExceptionPage } from "@autoforge/contracts";
import ExcelJS from "exceljs";
import {
  exportColumnWidth,
  exportWorksheetOptions,
  styleExportHeader,
  styleExportResult,
  styleExportRow,
} from "./export-workbook-style";
import { executionExceptionReasonLabel } from "./execution-exceptions-presentation";
import { runBatchStatusLabel } from "./run-batch-presentation";

const MAXIMUM_SHEET_RECORDS = 1_048_575;
const EXCEPTION_COLUMNS = [
  { header: "轮次", minimum: 8, maximum: 10 },
  { header: "步骤", minimum: 16, maximum: 18 },
  { header: "尝试", minimum: 8, maximum: 10 },
  { header: "用例名称", minimum: 20, maximum: 36 },
  { header: "用例类路径", minimum: 28, maximum: 52 },
  { header: "异常类型", minimum: 16, maximum: 20 },
  { header: "原因码", minimum: 24, maximum: 38 },
  { header: "说明", minimum: 36, maximum: 64 },
  { header: "判定影响", minimum: 14, maximum: 16 },
  { header: "发生时间", minimum: 26, maximum: 26 },
  { header: "原始时间（UTC）", minimum: 28, maximum: 28 },
] as const;

type ExceptionWorkbookInput = {
  firstPage: ExecutionExceptionPage;
  pages: AsyncIterable<ExecutionExceptionPage>;
  timeZone: string;
  signal?: AbortSignal;
};

export function createExecutionExceptionWorkbookStream(input: ExceptionWorkbookInput): {
  stream: PassThrough;
  completion: Promise<void>;
} {
  const stream = new PassThrough({ highWaterMark: 256 * 1024 });
  const controller = new AbortController();
  const abort = () => {
    const cause = input.signal?.reason ?? stream.errored ?? new Error("异常原因导出已取消。");
    controller.abort(cause);
    if (!stream.destroyed) stream.destroy(asError(cause));
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  stream.once("close", () => controller.abort(stream.errored));
  const completion = writeWorkbook(stream, input, controller.signal).finally(() =>
    input.signal?.removeEventListener("abort", abort),
  );
  void completion.catch((cause: unknown) => stream.destroy(asError(cause)));
  if (input.signal?.aborted) abort();
  return { stream, completion };
}

async function writeWorkbook(
  output: PassThrough,
  input: ExceptionWorkbookInput,
  signal: AbortSignal,
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useSharedStrings: false,
    useStyles: true,
  });
  workbook.creator = "AutoForge";
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const samples = input.firstPage.items.map((item) => exceptionRowValues(item, formatter));
  const definitions = EXCEPTION_COLUMNS.map((column, index) => ({
    header: index === 9 ? `${column.header}（${input.timeZone}）` : column.header,
    width: exportColumnWidth(
      column.header,
      samples.map((row) => String(row[index] ?? "")),
      column,
    ),
  }));
  function createSheet(number: number) {
    const sheet = workbook.addWorksheet(
      number === 1 ? "异常原因" : `异常原因 ${number}`,
      exportWorksheetOptions(3),
    );
    sheet.columns = definitions;
    sheet.autoFilter = { from: "A1", to: "K1" };
    const header = sheet.getRow(1);
    styleExportHeader(header);
    header.commit();
    return sheet;
  }
  let sheetNumber = 1;
  let sheet = createSheet(sheetNumber);
  let recordCount = 0;
  let sheetRecordCount = 0;
  for await (const page of input.pages) {
    signal.throwIfAborted();
    for (const item of page.items) {
      if (sheetRecordCount === MAXIMUM_SHEET_RECORDS) {
        sheet.commit();
        sheet = createSheet(++sheetNumber);
        sheetRecordCount = 0;
      }
      const row = sheet.addRow(exceptionRowValues(item, formatter));
      styleExportRow(row, EXCEPTION_COLUMNS.length);
      styleExportResult(row.getCell(9), item.affectsBatchStatus ? "error" : "neutral");
      row.getCell(8).alignment = { ...row.getCell(8).alignment, wrapText: true };
      row.commit();
      recordCount++;
      sheetRecordCount++;
    }
    // Yield between bounded pages so compression and HTTP delivery keep pace with SQLite reads.
    await setImmediate(undefined, { signal });
    if (output.writableNeedDrain) await once(output, "drain", { signal });
    signal.throwIfAborted();
  }
  sheet.commit();
  writeExceptionOverview(workbook, input.firstPage, recordCount, input.timeZone);
  signal.throwIfAborted();
  await workbook.commit();
}

function exceptionRowValues(
  item: ExecutionException,
  formatter: Intl.DateTimeFormat,
): Array<string | number> {
  return [
    item.round,
    item.kind === "recovery" ? "轮次环境恢复" : item.kind === "run" ? "用例终态" : "用例执行",
    item.attemptNumber ?? "",
    item.caseName ?? "轮次环境恢复",
    item.className ?? "",
    executionExceptionReasonLabel(item.resultCode),
    item.resultCode,
    item.summary,
    item.affectsBatchStatus ? "终态原因" : "历史异常",
    Number.isNaN(Date.parse(item.occurredAt))
      ? item.occurredAt
      : formatter.format(new Date(item.occurredAt)),
    item.occurredAt,
  ];
}

function writeExceptionOverview(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  firstPage: ExecutionExceptionPage,
  recordCount: number,
  timeZone: string,
): void {
  const overview = workbook.addWorksheet("判定概览", exportWorksheetOptions());
  overview.columns = [
    { header: "项目", width: 24 },
    { header: "内容", width: 64 },
  ];
  const overviewHeader = overview.getRow(1);
  styleExportHeader(overviewHeader);
  overviewHeader.commit();
  for (const cells of [
    ["批次编号", firstPage.batchId],
    ["当前状态", runBatchStatusLabel(firstPage.status)],
    ["按终态应有状态", runBatchStatusLabel(firstPage.expectedStatus)],
    ["判定核对", firstPage.consistent ? "一致" : "不一致"],
    ["非正常结束用例数", firstPage.abnormalRuns],
    ["异常记录数", recordCount],
    ["导出范围", "全部异常记录（含终态原因和历史异常）"],
    ["展示时区", timeZone],
  ]) {
    const row = overview.addRow(cells);
    styleExportRow(row, 2);
    row.commit();
  }
  overview.commit();
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("生成异常原因 Excel 失败。", { cause });
}
