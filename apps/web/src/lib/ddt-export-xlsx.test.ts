import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { buildExportWorkbook, parseSpreadsheet } from "@autoforge/ddt-import";
import type { DdtCaseData } from "@autoforge/domain";
import { buildStyledDdtExportWorkbook } from "./ddt-export-xlsx";

vi.mock("server-only", () => ({}));

async function load(buffer: Uint8Array) {
  const workbook = new ExcelJS.Workbook();
  await (
    workbook.xlsx.load.bind(workbook.xlsx) as unknown as (
      bytes: Uint8Array,
    ) => Promise<ExcelJS.Workbook>
  )(buffer);
  return workbook;
}

describe("styled DDT workbook", () => {
  it("rejects an empty export before opening a workbook stream", async () => {
    await expect(buildStyledDdtExportWorkbook([])).rejects.toThrow("没有符合条件的用例可导出");
  });
  it("preserves unique alias columns, literal formulas, leading zeros and typed values", async () => {
    const rows: DdtCaseData[] = [
      {
        CaseID: "00100000000000000000001",
        srNum: "PAYMENT",
        CaseName: "支付验证",
        owner: "Alice",
        Owner: "Bob",
        enabled: false,
        amount: 0,
        expression: "=1+1",
      },
      { CaseID: "CASE-2", srNum: "PAYMENT", casename: "退款验证", Owner: "Carol" },
    ];
    const buffer = await buildStyledDdtExportWorkbook(rows);
    expect(parseSpreadsheet(buffer, "styled.xlsx").rows).toEqual(
      parseSpreadsheet(buildExportWorkbook(rows), "original.xlsx").rows,
    );
    const sheet = (await load(buffer)).getWorksheet("data")!;
    expect(sheet.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FFE8EEF5" } });
    expect(sheet.getCell("A2").value).toBe(rows[0]!.CaseID);
    expect(sheet.getCell("A3").fill).toMatchObject({ fgColor: { argb: "FFF8FAFC" } });
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1, showGridLines: false });
    expect(sheet.pageSetup.printTitlesRow).toBe("1:1");
  });

  it("keeps missing journey steps missing and hides the round-trip marker", async () => {
    const rows: DdtCaseData[] = [
      {
        CaseID: "J-1",
        srNum: "PAY",
        用户旅程: {
          step1: { CaseID: "J-1", srNum: "PAY", action: "create" },
          step2: { CaseID: "J-1", srNum: "PAY", result: "paid" },
        },
      },
      {
        CaseID: "J-2",
        srNum: "PAY",
        用户旅程: { step1: { CaseID: "J-2", srNum: "PAY", Action: "cancel" } },
      },
    ];
    const buffer = await buildStyledDdtExportWorkbook(rows);
    expect(parseSpreadsheet(buffer, "journeys.xlsx").rows).toEqual(
      parseSpreadsheet(buildExportWorkbook(rows), "original.xlsx").rows,
    );
    const sheet = (await load(buffer)).getWorksheet("step2")!;
    const marker = sheet.columns.find(
      (_column, index) =>
        sheet.getRow(1).getCell(index + 1).value === "__DDT_INSIGHT_STEP_PRESENT__",
    );
    expect(marker?.hidden).toBe(true);
    expect(sheet.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FFE8EEF5" } });
  });

  it("fits short fields, Chinese headers and long text into distinct bounded widths without indent", async () => {
    const rows: DdtCaseData[] = [
      {
        CaseID: "00100000000000000000001",
        srNum: "PAY",
        CaseName: "支付结果验证",
        owner: "Alice",
        业务验证说明: "说明",
        details: "long payload ".repeat(1_000),
      },
    ];
    const sheet = (await load(await buildStyledDdtExportWorkbook(rows))).getWorksheet("data")!;
    expect(sheet.getColumn(1).width).toBeGreaterThan(sheet.getColumn(4).width!);
    expect(sheet.getColumn(4).width).toBeLessThan(14);
    expect(sheet.getColumn(5).width).toBeGreaterThanOrEqual("业务验证说明".length * 2 + 2);
    expect(sheet.getColumn(6).width).toBeLessThanOrEqual(42);
    expect(sheet.getCell("F2").value).toBe(rows[0]!.details);
    expect(sheet.getCell("F2").alignment.wrapText).toBe(true);
    sheet.getRow(2).eachCell((cell) => expect(cell.alignment.indent ?? 0).toBe(0));
  });

  it("samples widths without dropping later rows or expanding columns for an isolated outlier", async () => {
    const rows: DdtCaseData[] = Array.from({ length: 100 }, (_, index) => ({
      CaseID: `PAY-${index}`,
      srNum: "PAY",
      owner: "Alice",
    }));
    rows.push({ CaseID: "PAY-100", srNum: "PAY", owner: "长负责人名称".repeat(1_000) });
    const sheet = (await load(await buildStyledDdtExportWorkbook(rows))).getWorksheet("data")!;
    expect(sheet.getColumn(3).width).toBeLessThan(14);
    expect(sheet.actualRowCount).toBe(102);
    expect(sheet.getCell("C102").value).toBe(rows[100]!.owner);
  });
});
