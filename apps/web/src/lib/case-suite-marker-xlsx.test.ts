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
  expect(await parseCaseSuiteMarkerWorkbook(Buffer.concat(chunks), "标识.xlsx")).toEqual([
    { kind: "standard", memberId: "member-1", markers: ["00012", "", "=文本", "", "钱包"] },
    { kind: "ddt", memberId: "member-2", markers: ["", "", "", "", ""] },
  ]);
});

it("rejects formulas in a marker spreadsheet with the row number", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(CASE_SUITE_MARKER_SHEET);
  sheet.addRow([...CASE_SUITE_MARKER_WORKBOOK_HEADERS]);
  sheet.addRow(["DDT", "member-1", "钱包", { formula: "1+1", result: 2 }]);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  await expect(parseCaseSuiteMarkerWorkbook(bytes, "标识.xlsx")).rejects.toThrow("第 2 行含公式");
});
