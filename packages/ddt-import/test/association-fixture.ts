import * as XLSX from "xlsx";
export function buildAssociationWorkbookFixture(sheets: Record<string, unknown[][]>): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
