import type { RunBatchExportRow } from "@autoforge/application";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let buildRunBatchExportWorkbook: typeof import("./run-batch-export-xlsx").buildRunBatchExportWorkbook;

beforeAll(async () => {
  ({ buildRunBatchExportWorkbook } = await import("./run-batch-export-xlsx"));
});

const failedRow: RunBatchExportRow = {
  attemptId: "attempt-failed",
  casePath: "com.example.payment.PaymentTest",
  displayName: "submitPayment",
  outcome: "failed",
  resultCode: "TESTNG_ASSERTIONS_FAILED",
  summary:
    "java.lang.AssertionError: expected payment status SUCCESS but received PROCESSING at PaymentTest.java:86",
  startedAt: "2026-08-30T01:00:00.000Z",
  finishedAt: "2026-08-30T01:01:00.000Z",
  durationMs: 60_000,
  round: 2,
};

describe("buildRunBatchExportWorkbook", () => {
  it("builds the failure analysis template with only the required columns and editable widths", async () => {
    const shareLink = "https://autoforge.example/share/attempt-log/permanent-token";
    const result = await buildRunBatchExportWorkbook({
      batchId: "batch-123456789",
      template: "failure-analysis",
      scope: "final",
      rows: [failedRow],
      shareLinks: new Map([["attempt-failed", shareLink]]),
    });

    expect(result.filename).toBe("run-batch-batch-12-failure-analysis-final.xlsx");
    const workbook = await loadWorkbook(result.buffer);
    const sheet = workbook.getWorksheet("失败用例分析清单");
    expect(sheet).toBeDefined();
    expect(sheet!.getRow(1).values).toEqual([
      undefined,
      "用例编号",
      "用例名称",
      "失败堆栈",
      "分析责任人",
      "分析结果",
      "问题根因",
      "问题单号或用例修改证明",
      "重跑通过截图",
      "备注",
      "用例日志链接",
    ]);
    expect(sheet!.columnCount).toBe(10);
    expect(sheet!.columns.map((column) => column.width)).toEqual([
      48, 38, 68, 18, 22, 36, 38, 26, 32, 52,
    ]);

    const dataRow = sheet!.getRow(2);
    expect(dataRow.getCell(1).value).toBe(failedRow.casePath);
    expect(dataRow.getCell(2).value).toBe(failedRow.displayName);
    expect(dataRow.getCell(3).value).toBe(failedRow.summary);
    expect(dataRow.getCell(4).value).toBe("");
    expect(dataRow.getCell(5).dataValidation).toMatchObject({
      type: "list",
      allowBlank: true,
      formulae: ['"重跑通过,用例问题已修改,代码问题已提单"'],
    });
    expect(dataRow.getCell(10).value).toEqual({ text: shareLink, hyperlink: shareLink });
    expect(dataRow.height).toBe(58);
  });

  it("keeps the standard execution result workbook compatible when no template is supplied", async () => {
    const result = await buildRunBatchExportWorkbook({
      batchId: "batch-123456789",
      scope: "round",
      round: 2,
      rows: [failedRow],
      shareLinks: new Map(),
    });

    expect(result.filename).toBe("run-batch-batch-12-round-2.xlsx");
    const workbook = await loadWorkbook(result.buffer);
    expect(workbook.getWorksheet("执行结果")!.getRow(1).values).toContain("执行结果");
  });
});

async function loadWorkbook(buffer: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS 4 的声明尚未适配 Node 24 泛型 Buffer，其运行时实际支持 Uint8Array。
  const load = workbook.xlsx.load.bind(workbook.xlsx) as unknown as (
    content: Uint8Array,
  ) => Promise<ExcelJS.Workbook>;
  return load(buffer);
}
