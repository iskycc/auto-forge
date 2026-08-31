import "server-only";

import type { CaseSuiteExportRow } from "@autoforge/application";
import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";

const CASE_SUITE_EXPORT_HEADERS = ["用例编号（类路径）", "用例名称"] as const;
const FALLBACK_FILENAME = "case-suite-cases.xlsx";

export type CaseSuiteExportWorkbookStream = {
  stream: PassThrough;
  completion: Promise<void>;
};

/**
 * 使用 ExcelJS 的流式 writer 逐行提交，任务包含 10 万用例时也不会在 Web 进程中
 * 构造完整工作簿对象。共享字符串会保留所有唯一类名，因此这里显式关闭。
 */
export function createCaseSuiteExportWorkbookStream(
  rows: AsyncIterable<CaseSuiteExportRow>,
): CaseSuiteExportWorkbookStream {
  const stream = new PassThrough({ highWaterMark: 256 * 1_024 });
  const completion = writeWorkbook(stream, rows);
  void completion.catch((error: unknown) => stream.destroy(asError(error)));
  return { stream, completion };
}

async function writeWorkbook(
  output: PassThrough,
  rows: AsyncIterable<CaseSuiteExportRow>,
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useSharedStrings: false,
    useStyles: true,
  });
  workbook.creator = "AutoForge";
  const sheet = workbook.addWorksheet("任务用例", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: CASE_SUITE_EXPORT_HEADERS[0], key: "casePath", width: 52 },
    { header: CASE_SUITE_EXPORT_HEADERS[1], key: "displayName", width: 36 },
  ];
  sheet.autoFilter = { from: "A1", to: "B1" };

  const header = sheet.getRow(1);
  header.height = 28;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF315B7D" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  header.commit();

  for await (const item of rows) {
    const row = sheet.addRow({ casePath: item.casePath, displayName: item.displayName });
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
    });
    row.commit();
  }

  sheet.commit();
  await workbook.commit();
}

export function caseSuiteExportFilename(suiteName: string, suiteId: string): string {
  const safeName = suiteName
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  const identity = suiteId.slice(0, 8);
  return `${safeName || "用例任务"}-${identity}-用例.xlsx`;
}

/** RFC 5987 编码保证中文任务名在浏览器下载时保持可读。 */
export function caseSuiteExportContentDisposition(filename: string): string {
  return `attachment; filename="${FALLBACK_FILENAME}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("生成任务用例 Excel 失败。", { cause: error });
}
