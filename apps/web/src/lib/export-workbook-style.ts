import type ExcelJS from "exceljs";

/** Offline workbook theme: neutral surfaces, restrained semantic colors only for results. */
export const EXPORT_COLORS = {
  header: "FFE8EEF5",
  headerText: "FF334155",
  border: "FFE2E8F0",
  text: "FF334155",
  mutedText: "FF64748B",
  body: "FFFFFFFF",
  alternate: "FFF8FAFC",
  link: "FF2563A6",
} as const;
const FONT_NAME = "Microsoft YaHei UI";
export type ExportTone = "success" | "error" | "warning" | "info" | "neutral";
const RESULT_COLORS: Record<ExportTone, { fill: string; text: string }> = {
  success: { fill: "FFF0FDF4", text: "FF166534" },
  error: { fill: "FFFEF2F2", text: "FF991B1B" },
  warning: { fill: "FFFFFBEB", text: "FF92400E" },
  info: { fill: "FFEFF6FF", text: "FF1E40AF" },
  neutral: { fill: "FFF1F5F9", text: "FF475569" },
};

export function exportWorksheetOptions(frozenColumns = 1): Partial<ExcelJS.AddWorksheetOptions> {
  return {
    views: [{ state: "frozen", xSplit: frozenColumns, ySplit: 1, showGridLines: false }],
    properties: { defaultRowHeight: 22, tabColor: { argb: EXPORT_COLORS.link } },
    pageSetup: {
      orientation: "landscape",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "1:1",
    },
  };
}

export function styleExportHeader(row: ExcelJS.Row): void {
  row.height = 28;
  row.eachCell((cell) => {
    cell.font = {
      name: FONT_NAME,
      size: 10.5,
      bold: true,
      color: { argb: EXPORT_COLORS.headerText },
    };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: EXPORT_COLORS.header } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
  });
}

export function styleExportRow(row: ExcelJS.Row, columnCount: number): void {
  row.height = 22;
  // Touch all declared columns, including trailing empty notes, so the stripe remains continuous.
  for (let column = 1; column <= columnCount; column++) {
    const cell = row.getCell(column);
    cell.font = { name: FONT_NAME, size: 10, color: { argb: EXPORT_COLORS.text } };
    cell.alignment = {
      vertical: "middle",
      horizontal: typeof cell.value === "number" ? "right" : "left",
      indent: 1,
      wrapText: column === columnCount,
    };
    cell.border = {
      bottom: { style: "hair", color: { argb: EXPORT_COLORS.border } },
      right: { style: "hair", color: { argb: EXPORT_COLORS.border } },
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: row.number % 2 === 0 ? EXPORT_COLORS.body : EXPORT_COLORS.alternate },
    };
    if (typeof cell.value === "object" && cell.value && "hyperlink" in cell.value) {
      cell.font = { ...cell.font, color: { argb: EXPORT_COLORS.link }, underline: true };
    }
  }
}

export function styleExportResult(cell: ExcelJS.Cell, tone: ExportTone): void {
  const palette = RESULT_COLORS[tone];
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: palette.fill } };
  cell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: palette.text } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: false };
}
