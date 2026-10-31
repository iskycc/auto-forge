import * as XLSX from "xlsx";
import type { SpreadsheetZip } from "./archive";
import { readXlsxXml, xlsxText } from "./xlsx-xml";

export type XlsxCellFormats = {
  formats: ReadonlyMap<number, string>;
  styleFormats: number[];
  date1904: boolean;
  referencedStrings: Set<number>;
};
const numberFormats = XLSX.SSF as {
  format(format: string | number, value: number, options?: { date1904: boolean }): string;
  get_table(): Record<number, string>;
};

type SourceCell = {
  column: number;
  type: string;
  style: number;
  value: string;
  text: string;
  hasValue: boolean;
  hasInlineText: boolean;
  hasFormula: boolean;
};
const MAXIMUM_XLSX_COLUMNS = 16_384;
const MAXIMUM_XLSX_ROWS = 1_048_576;

export async function readXlsxSheet(
  archive: SpreadsheetZip,
  path: string,
  formats: XlsxCellFormats,
) {
  const rowsByNumber = new Map<number, unknown[]>();
  let row: unknown[] | undefined;
  let rowNumber = 0;
  let cell: SourceCell | undefined;
  let inSheetData = false;
  let valueText = false;
  let inlineText = false;
  let phoneticDepth = 0;
  let nextColumn = 0;
  await readXlsxXml(archive, path, {
    open(tag, name) {
      if (name === "sheetData") inSheetData = true;
      if (!inSheetData) return;
      if (name === "row") {
        rowNumber = tag.attributes.r ? Number(tag.attributes.r) : rowNumber + 1;
        if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAXIMUM_XLSX_ROWS)
          throw new Error("单元格行地址无效");
        row = rowsByNumber.get(rowNumber) ?? [];
        nextColumn = 0;
      }
      if (name === "c" && row) {
        const column = tag.attributes.r
          ? XLSX.utils.decode_col(tag.attributes.r.replace(/\d+$/, ""))
          : nextColumn;
        if (column < 0 || column >= MAXIMUM_XLSX_COLUMNS) throw new Error("单元格列地址无效");
        nextColumn = column + 1;
        cell = {
          column,
          type: tag.attributes.t ?? "n",
          style: Number(tag.attributes.s ?? 0),
          value: "",
          text: "",
          hasValue: false,
          hasInlineText: false,
          hasFormula: false,
        };
      }
      if (name === "rPh") phoneticDepth++;
      if (!cell) return;
      if (name === "f") cell.hasFormula = true;
      if (name === "v") {
        valueText = true;
        cell.hasValue = true;
      }
      if (name === "t" && !phoneticDepth && cell.type === "inlineStr") {
        inlineText = true;
        cell.hasInlineText = true;
      }
    },
    text(value) {
      if (!cell) return;
      if (valueText) cell.value += value;
      if (inlineText) cell.text += value;
    },
    close(name) {
      if (name === "v") valueText = false;
      if (name === "t") inlineText = false;
      if (name === "rPh") phoneticDepth--;
      if (name === "c" && cell && row) {
        const value = formattedValue(cell, formats);
        if (value !== undefined && value !== "") {
          row[cell.column] = value;
        }
        cell = undefined;
      }
      if (name === "row" && row) {
        if (Object.keys(row).length) rowsByNumber.set(rowNumber, row);
        row = undefined;
      }
      if (name === "sheetData") inSheetData = false;
    },
  });
  return [...rowsByNumber.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, values]) => values);
}

export function normalizeXlsxMatrix(
  matrix: unknown[][],
  options: { compactRows?: boolean } = {},
): unknown[][] {
  // Styled empty cells and inflated dimension metadata do not create DDT fields.
  let minimumColumn = Number.POSITIVE_INFINITY;
  let maximumColumn = -1;
  const nonemptyRows = matrix.filter((row) => {
    let hasContent = false;
    for (const key of Object.keys(row)) {
      const column = Number(key);
      if (row[column] === "" || row[column] === undefined) continue;
      hasContent = true;
      minimumColumn = Math.min(minimumColumn, column);
      maximumColumn = Math.max(maximumColumn, column);
    }
    return hasContent;
  });
  if (maximumColumn < 0) return [];
  const width = maximumColumn - minimumColumn + 1;
  return nonemptyRows.map((values, rowIndex) => {
    if (options.compactRows && rowIndex > 0) {
      if (minimumColumn === 0) return values;
      const shifted: unknown[] = [];
      for (const key of Object.keys(values))
        shifted[Number(key) - minimumColumn] = values[Number(key)];
      return shifted;
    }
    return minimumColumn === 0 && values.length === width && Object.keys(values).length === width
      ? values
      : Array.from({ length: width }, (_, column) => values[column + minimumColumn] ?? "");
  });
}

function formattedValue(cell: SourceCell, formats: XlsxCellFormats): string | number | undefined {
  if (cell.type === "inlineStr") return cell.hasInlineText ? xlsxText(cell.text) : "";
  if (cell.type === "s") {
    const index = Number(cell.value);
    if (!cell.hasValue || !Number.isInteger(index) || index < 0 || cell.value.trim() === "")
      throw new Error("单元格引用了不存在的共享字符串");
    // All ordinary values are formatted strings. Numeric placeholders keep the
    // first pass compact until only the referenced shared strings are loaded.
    formats.referencedStrings.add(index);
    return index;
  }
  if (cell.type === "str") return xlsxText(cell.value);
  if (cell.type === "e") return undefined;
  if (!cell.hasValue && !cell.hasFormula) return undefined;
  if (cell.type === "b") return cell.value === "1" || cell.value === "true" ? "TRUE" : "FALSE";
  const formatId = formats.styleFormats[cell.style] ?? 0;
  const format = formats.formats.get(formatId) ?? formatId;
  if (cell.type === "d") {
    const date = new Date(cell.value);
    if (!Number.isFinite(date.getTime())) throw new Error("日期单元格值无效");
    return XLSX.utils.format_cell({
      t: "d",
      v: date,
      z: typeof format === "string" ? format : (numberFormats.get_table()[format] ?? "m/d/yy"),
    });
  }
  const value = cell.hasValue ? Number.parseFloat(cell.value) : 0;
  if (!Number.isFinite(value)) {
    if (cell.value === "") return undefined;
    throw new Error("数值单元格值无效");
  }
  try {
    return numberFormats.format(format, value, { date1904: formats.date1904 });
  } catch {
    // Match the existing reader's General fallback for unsupported custom formats.
    return numberFormats.format(0, value);
  }
}
