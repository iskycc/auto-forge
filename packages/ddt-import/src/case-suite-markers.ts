import * as XLSX from "xlsx";
import {
  CASE_SUITE_MARKER_FILE_BYTES,
  CASE_SUITE_MARKER_IMPORT_LIMIT,
  CASE_SUITE_MARKER_SHEET,
  CASE_SUITE_MARKER_WORKBOOK_HEADERS,
  caseSuiteMarkerEditSchema,
  type CaseSuiteMarkerEdit,
} from "@autoforge/contracts";
import { openSpreadsheetZip } from "./archive";

export async function parseCaseSuiteMarkerWorkbook(content: Uint8Array, fileName: string) {
  if (!fileName.toLowerCase().endsWith(".xlsx") || content.length > CASE_SUITE_MARKER_FILE_BYTES)
    throw new Error("请上传不超过 16 MiB 的任务用例标识 XLSX。");
  const archive = openSpreadsheetZip(content, {
    maximumEntries: 512,
    maximumExpandedBytes: 64 * 1024 * 1024,
  });
  for (const path of archive.paths()) {
    let tail = "";
    for await (const chunk of archive.readChunks(path)) {
      if (!path.endsWith(".xml") && !path.endsWith(".rels")) continue;
      const text = (tail + chunk.toString("latin1")).toUpperCase();
      if (/<!DOCTYPE|<!ENTITY|\0/u.test(text)) throw new Error("标识表包含不支持的 XML 内容。");
      tail = text.slice(-16);
    }
  }

  const workbook = XLSX.read(content, {
    type: "array",
    sheets: [CASE_SUITE_MARKER_SHEET],
    sheetRows: CASE_SUITE_MARKER_IMPORT_LIMIT + 2,
    cellHTML: false,
    cellFormula: true,
    cellText: false,
  });
  const sheet = workbook.Sheets[CASE_SUITE_MARKER_SHEET];
  if (!sheet?.["!ref"]) throw new Error("请保留导出文件中的“任务用例标识”工作表。");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (
    range.s.r !== 0 ||
    range.s.c !== 0 ||
    range.e.c !== CASE_SUITE_MARKER_WORKBOOK_HEADERS.length - 1 ||
    range.e.r > CASE_SUITE_MARKER_IMPORT_LIMIT
  )
    throw new Error("标识表列范围不正确，或超过 100,000 条。");

  const cell = (row: number, column: number) =>
    sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
  if (CASE_SUITE_MARKER_WORKBOOK_HEADERS.some((header, column) => cell(0, column)?.v !== header))
    throw new Error("请保留导出表头及列顺序。");

  const edits: CaseSuiteMarkerEdit[] = [];
  const seen = new Set<string>();
  for (let row = 1; row <= range.e.r; row++) {
    const cells = CASE_SUITE_MARKER_WORKBOOK_HEADERS.map((_, column) => cell(row, column));
    const values = cells.map((entry) => entry?.v ?? "");
    if (cells.some((entry) => entry?.f || entry?.t === "e"))
      throw new Error(`第 ${row + 1} 行含公式或错误单元格，请改为文本。`);
    if (values.every((value) => value === "")) continue;
    const parsed = caseSuiteMarkerEditSchema.safeParse({
      kind: values[0] === "普通用例" ? "standard" : values[0] === "DDT" ? "ddt" : undefined,
      memberId: values[1],
      markers: values.slice(3).map((value) => (typeof value === "number" ? String(value) : value)),
    });
    if (!parsed.success)
      throw new Error(`第 ${row + 1} 行的用例类型、成员 ID 或标识不正确。标识限单行 120 字符。`);
    const key = `${parsed.data.kind}:${parsed.data.memberId}`;
    if (seen.has(key)) throw new Error(`第 ${row + 1} 行的用例成员重复。`);
    seen.add(key);
    edits.push(parsed.data);
  }
  if (!edits.length) throw new Error("标识表没有可导入的用例。");
  return edits;
}
