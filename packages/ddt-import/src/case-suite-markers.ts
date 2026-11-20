import * as XLSX from "xlsx";
import {
  CASE_SUITE_MARKER_FILE_BYTES,
  CASE_SUITE_MARKER_IMPORT_LIMIT,
  CASE_SUITE_MARKER_SHEET,
  CASE_SUITE_MARKER_WORKBOOK_HEADERS,
  caseSuiteMarkerImportRowSchema,
  type CaseSuiteMarkerImportRow,
} from "@autoforge/contracts";
import { openSpreadsheetZip } from "./archive";

const legacyHeaders = ["用例类型", "成员 ID"];
const invalidHeaders = "请保留“用例、标识1、标识2、标识3、标识4、标识5”表头及列顺序。";

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
  if (range.e.r > CASE_SUITE_MARKER_IMPORT_LIMIT)
    throw new Error("标识表最多支持 100,000 条用例。");

  const cell = (row: number, column: number) =>
    sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
  const columnCount = range.e.c + 1;
  const requiredColumnCount = CASE_SUITE_MARKER_WORKBOOK_HEADERS.length;
  if (
    range.s.r !== 0 ||
    range.s.c !== 0 ||
    columnCount > requiredColumnCount + legacyHeaders.length
  )
    throw new Error(invalidHeaders);
  const headers = Array.from({ length: columnCount }, (_, column) => cell(0, column)?.v ?? "");
  const offset = headers.indexOf(CASE_SUITE_MARKER_WORKBOOK_HEADERS[0]);
  const legacy = headers.slice(0, offset);
  const end = offset + requiredColumnCount;
  if (
    offset < 0 ||
    legacy.some((value) => !legacyHeaders.some((header) => value === header)) ||
    new Set(legacy).size !== legacy.length ||
    CASE_SUITE_MARKER_WORKBOOK_HEADERS.some(
      (header, column) => headers[offset + column] !== header,
    ) ||
    headers.slice(end).some((header) => header !== "")
  )
    throw new Error(invalidHeaders);

  const rows: CaseSuiteMarkerImportRow[] = [];
  for (let row = 1; row <= range.e.r; row++) {
    // 保存删除列后的文件时，工作表范围可能还包括旧列留下的空单元格。
    for (let column = end; column < columnCount; column++) {
      const extra = cell(row, column);
      if (extra?.f || extra?.t === "e" || (extra?.v ?? "") !== "")
        throw new Error(`第 ${row + 1} 行在“标识5”之后还有数据，请删除额外列。`);
    }
    const cells = CASE_SUITE_MARKER_WORKBOOK_HEADERS.map((_, column) => cell(row, offset + column));
    if (cells.some((entry) => entry?.f || entry?.t === "e"))
      throw new Error(`第 ${row + 1} 行含公式或错误单元格，请改为文本。`);
    const values = cells.map((entry) =>
      typeof entry?.v === "number" ? String(entry.v) : (entry?.v ?? ""),
    );
    if (values.every((value) => value === "")) continue;
    const [caseLabel, ...markers] = values;
    const parsed = caseSuiteMarkerImportRowSchema.safeParse({
      rowNumber: row + 1,
      caseLabel,
      markers,
    });
    if (!parsed.success)
      throw new Error(
        `第 ${row + 1} 行的用例或标识不正确。请填写完整类路径或 CaseID，标识限单行 120 字符。`,
      );
    rows.push(parsed.data);
  }
  if (!rows.length) throw new Error("标识表没有可导入的用例。");
  return rows;
}
