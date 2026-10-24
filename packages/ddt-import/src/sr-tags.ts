import * as XLSX from "xlsx";
import { normalizeDdtSrTagKey } from "@autoforge/domain";
import {
  SR_TAG_IMPORT_MAXIMUM_BYTES,
  SR_TAG_IMPORT_MAXIMUM_ROWS,
  SR_TAG_IMPORT_ISSUE_LIMIT,
  srTagClassificationSchema,
  type ParsedSrTagImport,
  type SrTagImportIssue,
} from "@autoforge/contracts";
import { readSpreadsheetWorkbook } from "./spreadsheet";

const TAG_HEADERS = new Set(["标签", "标签名称", "tag", "tags"]);
const SR_HEADERS = new Set(["sr", "srnum"]);
const MAXIMUM_TEXT_CHARACTERS = 16 * 1024 * 1024;

/** The file parser is called in the existing bounded parsing worker, never on the Web event loop. */
export function parseSrTagSpreadsheet(content: Uint8Array, fileName: string): ParsedSrTagImport {
  if (content.byteLength > SR_TAG_IMPORT_MAXIMUM_BYTES)
    throw new Error("SR 标签表格不能超过 16 MiB。");
  const workbook = readSpreadsheetWorkbook(Buffer.from(content), fileName, {
    maximumRows: SR_TAG_IMPORT_MAXIMUM_ROWS + 2,
    preserveCsvText: true,
  });
  const result: ParsedSrTagImport = { rows: [], rowCount: 0, issueCount: 0, issues: [] };
  const seen = new Map<string, { sheetName: string; rowNumber: number }>();
  let characters = 0;
  const issue = (entry: SrTagImportIssue) => {
    result.issueCount++;
    if (result.issues.length < SR_TAG_IMPORT_ISSUE_LIMIT) result.issues.push(entry);
  };
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]!;
    const cells = (sheet as XLSX.WorkSheet & { "!data"?: XLSX.CellObject[][] })["!data"] ?? [];
    if (!sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(String(sheet["!fullref"] ?? sheet["!ref"]));
    if (range.e.r > SR_TAG_IMPORT_MAXIMUM_ROWS)
      throw new Error("每次最多导入 100,000 行，请移除多余空行或分批导入。");
    const value = (row: number, column: number) => {
      const cell = cells[row]?.[column];
      return cell ? String(cell.w ?? XLSX.utils.format_cell(cell)).trim() : "";
    };
    if (
      !cells.some((row, index) => row && Object.keys(row).some((key) => value(index, Number(key))))
    )
      continue;
    const srHeader = value(0, 0).replace(/^\uFEFF/u, "");
    const tagHeader = value(0, 1).replace(/^\uFEFF/u, "");
    if (
      !SR_HEADERS.has(normalizeDdtSrTagKey(srHeader)) ||
      !TAG_HEADERS.has(normalizeDdtSrTagKey(tagHeader))
    ) {
      issue({
        sheetName,
        rowNumber: 1,
        srNum: srHeader,
        tagName: tagHeader,
        reason: "第一行必须是表头：第一列 SR，第二列 标签（也支持 Tag/Tags）。",
      });
      continue;
    }
    for (let rowIndex = 0; rowIndex <= range.e.r; rowIndex++) {
      const srNum = value(rowIndex, 0),
        tagName = value(rowIndex, 1);
      const extra = Object.keys(cells[rowIndex] ?? []).some(
        (key) => Number(key) > 1 && value(rowIndex, Number(key)) !== "",
      );
      if (rowIndex === 0) {
        if (extra)
          issue({ sheetName, rowNumber: 1, srNum, tagName, reason: "表格只能包含 SR、标签两列。" });
        continue;
      }
      if (!srNum && !tagName && !extra) continue;
      if (++result.rowCount > SR_TAG_IMPORT_MAXIMUM_ROWS)
        throw new Error("每次最多导入 100,000 行，请分批导入。");
      const location = { sheetName, rowNumber: rowIndex + 1 };
      const invalid = srTagClassificationSchema.safeParse({ srNum, tagName });
      const formula = Boolean(cells[rowIndex]?.[0]?.f || cells[rowIndex]?.[1]?.f);
      if (extra || formula || !invalid.success || /[\u0000-\u001f\u007f]/u.test(srNum + tagName)) {
        issue({
          ...location,
          srNum: srNum.slice(0, 512),
          tagName: tagName.slice(0, 64),
          reason: extra
            ? "表格只能包含 SR、标签两列。"
            : formula
              ? "SR 和标签须填写固定值，不支持公式。"
              : "SR 与标签不能为空；SR 最多 512 字符，标签最多 64 字符，且不能包含控制字符。",
        });
        continue;
      }
      const key = JSON.stringify([normalizeDdtSrTagKey(srNum), normalizeDdtSrTagKey(tagName)]);
      const first = seen.get(key);
      if (first) {
        issue({
          ...location,
          srNum,
          tagName,
          reason: `同一 SR 的相同标签重复，首次位于 ${first.sheetName} 第 ${first.rowNumber} 行（忽略大小写和首尾空白）。`,
        });
        continue;
      }
      seen.set(key, location);
      characters += srNum.length + tagName.length;
      if (characters > MAXIMUM_TEXT_CHARACTERS)
        throw new Error("表格解析后的文本超过 16 MiB 字符，请分批导入。");
      result.rows.push({ ...location, srNum, tagName });
    }
  }
  if (!result.rowCount && !result.issueCount)
    issue({
      sheetName: workbook.SheetNames[0] ?? "Sheet1",
      rowNumber: 1,
      srNum: "",
      tagName: "",
      reason: "表格没有可导入的数据，请在 SR、标签表头下填写关联。",
    });
  return result;
}
