import "server-only";

import { PassThrough } from "node:stream";
import type { DdtCaseData, DdtCellValue } from "@autoforge/domain";
import { buildDdtExportSheets } from "@autoforge/ddt-import";
import ExcelJS from "exceljs";
import {
  exportColumnWidth,
  EXPORT_WIDTH_SAMPLE_ROWS,
  exportWorksheetOptions,
  styleExportHeader,
  stylePopulatedExportRow,
} from "./export-workbook-style";

export async function buildStyledDdtExportWorkbook(rows: DdtCaseData[]): Promise<Buffer> {
  const sheets = buildDdtExportSheets(rows);
  const stream = new PassThrough({ highWaterMark: 256 * 1_024 });
  const content = collectWorkbook(stream);
  const completion = writeDdtWorkbook(sheets, stream).catch((error: unknown) => {
    stream.destroy(
      error instanceof Error ? error : new Error("生成 DDT Excel 失败。", { cause: error }),
    );
    throw error;
  });
  const [buffer] = await Promise.all([content, completion]);
  return buffer;
}

async function collectWorkbook(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function writeDdtWorkbook(
  sheets: ReturnType<typeof buildDdtExportSheets>,
  stream: PassThrough,
): Promise<void> {
  // Commit cells as they are written; styling must not retain a second full in-memory workbook.
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useSharedStrings: false,
    useStyles: true,
  });
  workbook.creator = "AutoForge";
  for (const definition of sheets) {
    const sheet = workbook.addWorksheet(definition.name, exportWorksheetOptions());
    const columnIndexes = new Map(
      definition.columns.map((column, index) => [column.name, index + 1]),
    );
    const samples = definition.rows.slice(0, EXPORT_WIDTH_SAMPLE_ROWS);
    sheet.columns = definition.columns.map((column) => ({
      header: column.name,
      width: exportColumnWidth(
        column.name,
        samples.map((cells) => String(cells[column.name] ?? "")),
        { minimum: ddtColumnMinimumWidth(column.name), maximum: 42 },
      ),
      hidden: column.hidden,
    }));
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: definition.columns.length },
    };
    const header = sheet.getRow(1);
    styleExportHeader(header);
    header.commit();
    for (const cells of definition.rows) {
      appendStyledDdtExportRow(sheet, columnIndexes, Object.entries(cells));
    }
    sheet.commit();
  }
  await workbook.commit();
}

/** Preserve original values while omitting absent SR fields from XLSX cell records. */
export function appendStyledDdtExportRow(
  sheet: ExcelJS.Worksheet,
  columnIndexes: ReadonlyMap<string, number>,
  fields: Iterable<readonly [string, DdtCellValue]>,
): void {
  const row = sheet.addRow([]);
  for (const [name, value] of fields) {
    // Blank source cells remain blank through the header schema; preserve 0, false and spaces.
    if (value === null || value === "") continue;
    const column = columnIndexes.get(name);
    if (column === undefined) throw new Error(`DDT 导出列映射缺失：${name}`);
    row.getCell(column).value = value;
  }
  stylePopulatedExportRow(row, columnIndexes.size);
  row.commit();
}

export function ddtColumnMinimumWidth(header: string): number {
  switch (header.toLowerCase()) {
    case "caseid":
      return 12;
    case "srnum":
      return 10;
    case "casename":
      return 16;
    default:
      return 8;
  }
}
