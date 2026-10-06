import "server-only";

import { PassThrough } from "node:stream";
import type { DdtCaseData } from "@autoforge/domain";
import { buildDdtExportSheets } from "@autoforge/ddt-import";
import ExcelJS from "exceljs";
import {
  exportColumnWidth,
  EXPORT_WIDTH_SAMPLE_ROWS,
  exportWorksheetOptions,
  styleExportHeader,
  styleExportRow,
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
      const row = sheet.addRow(definition.columns.map((column) => cells[column.name] ?? null));
      styleExportRow(row, definition.columns.length);
      row.commit();
    }
    sheet.commit();
  }
  await workbook.commit();
}

function ddtColumnMinimumWidth(header: string): number {
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
