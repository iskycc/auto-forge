import { parseCaseSuiteMarkerWorkbook } from "@autoforge/ddt-import";
import { expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { CASE_SUITE_MARKER_SHEET, CASE_SUITE_MARKER_WORKBOOK_HEADERS } from "@autoforge/contracts";

vi.mock("server-only", () => ({}));

it("reads records exported as text, preserving gaps and leading zeros", async () => {
  const { createCaseSuiteMarkerWorkbook } = await import("./case-suite-marker-xlsx");
  const stream = createCaseSuiteMarkerWorkbook(
    (async function* () {
      yield {
        kind: "standard",
        memberId: "member-1",
        caseLabel: "example.Test",
        markers: ["00012", "", "=文本", "", "钱包"],
      };
      yield { kind: "ddt", memberId: "member-2", caseLabel: "中文用例", markers: [] };
    })(),
    new AbortController().signal,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  const sheet = workbook.getWorksheet(CASE_SUITE_MARKER_SHEET)!;
  expect(sheet.columnCount).toBe(6);
  expect(Array.from({ length: 6 }, (_, index) => sheet.getCell(1, index + 1).text)).toEqual([
    "用例",
    "标识1",
    "标识2",
    "标识3",
    "标识4",
    "标识5",
  ]);
  expect(await parseCaseSuiteMarkerWorkbook(bytes, "标识.xlsx")).toEqual([
    { rowNumber: 2, caseLabel: "example.Test", markers: ["00012", "", "=文本", "", "钱包"] },
    { rowNumber: 3, caseLabel: "中文用例", markers: ["", "", "", "", ""] },
  ]);
});

it.each([
  { removedColumns: 0, firstColumn: 1 },
  { removedColumns: 1, firstColumn: 1 },
  { removedColumns: 1, firstColumn: 2 },
  { removedColumns: 2, firstColumn: 1 },
])(
  "reads old workbooks after deleting $removedColumns columns from column $firstColumn",
  async ({ removedColumns, firstColumn }) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(CASE_SUITE_MARKER_SHEET);
    sheet.addRow(["用例类型", "成员 ID", ...CASE_SUITE_MARKER_WORKBOOK_HEADERS]);
    sheet.addRow(["旧类型", "旧ID", "00012", "回归", "", "", "", ""]);
    if (removedColumns) sheet.spliceColumns(firstColumn, removedColumns);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    expect(await parseCaseSuiteMarkerWorkbook(bytes, "标识.xlsx")).toEqual([
      { rowNumber: 2, caseLabel: "00012", markers: ["回归", "", "", "", ""] },
    ]);
  },
);

it("rejects formulas in a marker spreadsheet with the row number", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(CASE_SUITE_MARKER_SHEET);
  sheet.addRow([...CASE_SUITE_MARKER_WORKBOOK_HEADERS]);
  sheet.addRow(["钱包", { formula: "1+1", result: 2 }]);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  await expect(parseCaseSuiteMarkerWorkbook(bytes, "标识.xlsx")).rejects.toThrow("第 2 行含公式");
});
