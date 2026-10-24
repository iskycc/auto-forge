import * as XLSX from "xlsx";

/** Build a literal two-column fixture without the DDT exporter's managed CaseID/srNum fields. */
export function buildSrTagSpreadsheetFixture(rows: readonly Record<string, unknown>[]): Buffer {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? "")),
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "分类");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
