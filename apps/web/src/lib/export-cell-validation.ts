import type { ExportRowIssue } from "@autoforge/contracts";
import type { RunBatchExportRow } from "@autoforge/application";
import type ExcelJS from "exceljs";

export const EXCEL_CELL_TEXT_LIMIT = 32_767;
export const EXCEL_CELL_LINE_FEED_LIMIT = 253;
export const EXCEL_SHEET_HYPERLINK_LIMIT = 65_530;
export const EXCEL_SHEET_ROW_LIMIT = 1_048_576;

function forbiddenXmlCodePoint(code: number): boolean {
  return (
    (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0xfffe ||
    code === 0xffff
  );
}

function textIssues(value: string, cellText = true): string[] {
  const reasons: string[] = [];
  if (cellText && value.length > EXCEL_CELL_TEXT_LIMIT)
    reasons.push(
      `文本超过 Excel 单元格 ${EXCEL_CELL_TEXT_LIMIT} 字符上限（当前 ${value.length}）。`,
    );
  let lineFeeds = 0;
  for (let offset = 0; offset < value.length;) {
    const code = value.codePointAt(offset)!;
    if (forbiddenXmlCodePoint(code)) {
      reasons.push(
        `包含 Excel 无法保存的字符 U+${code.toString(16).toUpperCase().padStart(4, "0")}（文本位置 ${offset + 1}）。`,
      );
      break;
    }
    if (code === 10) lineFeeds++;
    offset += code > 0xffff ? 2 : 1;
  }
  if (cellText && lineFeeds > EXCEL_CELL_LINE_FEED_LIMIT)
    reasons.push(`换行超过 Excel 单元格 ${EXCEL_CELL_LINE_FEED_LIMIT} 行上限。`);
  return reasons;
}

/** Reports never include failure text or link targets, and their identifiers remain safe in XML. */
export function exportIssueText(value: string, maximumLength = 1_024): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const visible = forbiddenXmlCodePoint(code)
      ? `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`
      : /\s/u.test(character)
        ? " "
        : character;
    if (result.length + visible.length >= maximumLength) return `${result}…`;
    result += visible;
  }
  return result;
}

export function validateExportCells(
  cells: readonly ExcelJS.CellValue[],
  headers: readonly string[],
  source: RunBatchExportRow,
  rowNumber: number,
): ExportRowIssue | undefined {
  const fields: ExportRowIssue["fields"] = [];
  cells.forEach((cell, index) => {
    const field = headers[index]!;
    if (typeof cell === "string") {
      for (const reason of textIssues(cell)) fields.push({ field, reason });
    } else if (typeof cell === "number" && !Number.isFinite(cell)) {
      fields.push({ field, reason: "数值不是有限数字，无法写入 Excel。" });
    } else if (cell && typeof cell === "object" && "hyperlink" in cell) {
      for (const reason of textIssues(cell.text)) fields.push({ field, reason });
      for (const reason of textIssues(cell.hyperlink, false)) fields.push({ field, reason });
      try {
        const target = new URL(cell.hyperlink);
        if (target.protocol !== "http:" && target.protocol !== "https:")
          fields.push({ field, reason: "链接不是有效的 HTTP(S) 地址。" });
      } catch (cause) {
        if (!(cause instanceof TypeError)) throw cause;
        fields.push({ field, reason: "链接不是有效的 HTTP(S) 地址。" });
      }
    }
  });
  if (fields.length === 0) return undefined;
  return {
    rowNumber,
    executionRunId: exportIssueText(source.executionRunId, 160),
    attemptId: source.attemptId === null ? null : exportIssueText(source.attemptId, 160),
    round: source.round,
    casePath: exportIssueText(source.casePath),
    caseName: exportIssueText(source.displayName, 512),
    fields,
  };
}

export function exportRowHyperlinkCount(cells: readonly ExcelJS.CellValue[]): number {
  return cells.filter((cell) => cell && typeof cell === "object" && "hyperlink" in cell).length;
}
