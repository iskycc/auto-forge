import type { RunBatchExportRow } from "@autoforge/application";
import type { FailureAnalysisClaim } from "@autoforge/domain";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let buildRunBatchExportWorkbook: typeof import("./run-batch-export-xlsx").buildRunBatchExportWorkbook;

beforeAll(async () => {
  ({ buildRunBatchExportWorkbook } = await import("./run-batch-export-xlsx"));
});

const failedRow: RunBatchExportRow = {
  attemptId: "attempt-failed",
  executionRunId: "run-failed",
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

const completedClaim: FailureAnalysisClaim = {
  id: "analysis-failed",
  projectId: "project-a",
  batchId: "batch-123456789",
  executionRunId: "run-failed",
  caseDefinitionId: "case-failed",
  attemptId: failedRow.attemptId!,
  caseName: failedRow.displayName,
  className: failedRow.casePath,
  attemptNumber: failedRow.round,
  failureSummary: failedRow.summary!,
  status: "completed",
  category: "case_fixed",
  claimantId: "analyst-a",
  claimantUsername: "c10001",
  claimantDisplayName: "分析员 A",
  claimedAt: "2026-08-30T02:00:00.000Z",
  completedAt: "2026-08-30T02:10:00.000Z",
  issueDescription: "测试数据字段已经失效",
  caseFixEvidence: "https://git.example/commit/abc123",
  remark: "已回归确认",
  updatedAt: "2026-08-30T02:10:00.000Z",
};

describe("buildRunBatchExportWorkbook", () => {
  it.each(["round", "final", "all"] as const)(
    "exports %s execution timestamps in Beijing time by default",
    async (scope) => {
      const result = await buildRunBatchExportWorkbook({
        batchId: "batch-123456789",
        scope,
        round: 2,
        rows: [failedRow],
        shareLinks: new Map(),
      });
      const sheet = (await loadWorkbook(result.buffer)).getWorksheet("执行结果")!;
      const startColumn = scope === "all" ? 6 : 5;
      expect(sheet.getRow(2).getCell(startColumn).value).toBe("2026-08-30 09:00:00.000");
      expect(sheet.getRow(2).getCell(startColumn + 1).value).toBe("2026-08-30 09:01:00.000");
      expect(sheet.getRow(2).getCell(startColumn + 2).value).toBe(60);
      expect(failedRow.startedAt).toBe("2026-08-30T01:00:00.000Z");
    },
  );

  it.each([
    { instant: "2026-10-07T16:00:00.123Z", expected: "2026-10-08 00:00:00.123" },
    { instant: "2026-12-31T16:30:59.999Z", expected: "2027-01-01 00:30:59.999" },
    { instant: "2026-10-08T00:30:59.123+08:00", expected: "2026-10-08 00:30:59.123" },
  ])(
    "preserves milliseconds and the local calendar date for $instant",
    async ({ instant, expected }) => {
      const result = await buildRunBatchExportWorkbook({
        batchId: "batch-123456789",
        scope: "final",
        rows: [{ ...failedRow, startedAt: instant, finishedAt: instant }],
        shareLinks: new Map(),
      });
      const sheet = (await loadWorkbook(result.buffer)).getWorksheet("执行结果")!;
      expect(sheet.getCell("E2").value).toBe(expected);
      expect(sheet.getCell("F2").value).toBe(expected);
    },
  );

  it.each([
    { instant: "2026-07-15T12:30:00.000Z", expected: "2026-07-15 08:30:00.000" },
    { instant: "2026-01-15T12:30:00.000Z", expected: "2026-01-15 07:30:00.000" },
  ])("uses the supplied platform time zone for $instant", async ({ instant, expected }) => {
    const result = await buildRunBatchExportWorkbook({
      batchId: "batch-123456789",
      scope: "final",
      timeZone: "America/New_York",
      rows: [{ ...failedRow, startedAt: instant, finishedAt: instant }],
      shareLinks: new Map(),
    });
    const sheet = (await loadWorkbook(result.buffer)).getWorksheet("执行结果")!;
    expect(sheet.getCell("E2").value).toBe(expected);
    expect(sheet.getCell("F2").value).toBe(expected);
  });

  it("leaves missing execution timestamps and durations blank", async () => {
    const result = await buildRunBatchExportWorkbook({
      batchId: "batch-123456789",
      scope: "final",
      rows: [{ ...failedRow, startedAt: null, finishedAt: null, durationMs: null }],
      shareLinks: new Map(),
    });
    const sheet = (await loadWorkbook(result.buffer)).getWorksheet("执行结果")!;
    for (const address of ["E2", "F2", "G2"]) expect(sheet.getCell(address).text).toBe("");
  });

  it.each([
    { template: "results" as const, scope: "round" as const, logColumn: 8, rowHeight: 22 },
    { template: "results" as const, scope: "final" as const, logColumn: 8, rowHeight: 22 },
    { template: "results" as const, scope: "all" as const, logColumn: 9, rowHeight: 22 },
    {
      template: "failure-analysis" as const,
      scope: "final" as const,
      logColumn: 10,
      rowHeight: 20,
    },
  ])(
    "keeps complete $template/$scope log URLs on a wide single-line column",
    async ({ template, scope, logColumn, rowHeight }) => {
      const shareLink = `https://autoforge.internal.example:3443/share/attempt-log/${"t".repeat(43)}`;
      const result = await buildRunBatchExportWorkbook({
        batchId: "batch-123456789",
        template,
        scope,
        round: 2,
        rows: [failedRow],
        shareLinks: new Map([[failedRow.attemptId!, shareLink]]),
      });
      const sheet = (await loadWorkbook(result.buffer)).worksheets[0]!;
      const cell = sheet.getRow(2).getCell(logColumn);
      expect(sheet.getColumn(logColumn).width).toBeGreaterThanOrEqual(shareLink.length + 2);
      expect(cell.value).toEqual({ text: shareLink, hyperlink: shareLink });
      expect(cell.alignment.wrapText).not.toBe(true);
      expect(cell.alignment.indent ?? 0).toBe(0);
      expect(cell.font).toMatchObject({ underline: true, color: { argb: "FF2563A6" } });
      expect(sheet.getRow(2).height).toBe(rowHeight);
    },
  );

  it.each(["results", "failure-analysis"] as const)(
    "bounds %s log width while preserving unusually long and missing URLs",
    async (template) => {
      const shareLink = `https://autoforge.internal.example/${"long-path/".repeat(100)}`;
      const rows = [failedRow, { ...failedRow, attemptId: "attempt-no-share" }];
      const result = await buildRunBatchExportWorkbook({
        batchId: "batch-123456789",
        template,
        scope: "final",
        rows,
        shareLinks: new Map([[failedRow.attemptId!, shareLink]]),
      });
      const sheet = (await loadWorkbook(result.buffer)).worksheets[0]!;
      const logColumn = sheet.columnCount;
      expect(sheet.getColumn(logColumn).width).toBeLessThanOrEqual(120);
      expect(sheet.getColumn(logColumn).width).toBeGreaterThanOrEqual(64);
      expect(sheet.getRow(2).getCell(logColumn).value).toEqual({
        text: shareLink,
        hyperlink: shareLink,
      });
      expect(sheet.getRow(2).getCell(logColumn).alignment.wrapText).not.toBe(true);
      expect(sheet.getRow(3).getCell(logColumn).text).toBe("");
    },
  );

  it("builds a compact single-line failure analysis template with the required columns", async () => {
    const shareLink = "https://autoforge.example/share/attempt-log/permanent-token";
    const result = await buildRunBatchExportWorkbook({
      batchId: "batch-123456789",
      template: "failure-analysis",
      scope: "final",
      rows: [failedRow],
      shareLinks: new Map([["attempt-failed", shareLink]]),
      analysisClaims: new Map([["attempt-failed", completedClaim]]),
      analysisProofLinks: new Map(),
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
      32, 24, 36, 14, 18, 24, 24, 18, 20, 64,
    ]);
    expect(sheet!.getRow(1).height).toBe(28);
    expect(sheet!.getRow(1).getCell(1).font).toMatchObject({
      name: "Microsoft YaHei UI",
      bold: true,
      color: { argb: "FF334155" },
    });
    expect(sheet!.getRow(1).getCell(1).fill).toMatchObject({
      type: "pattern",
      fgColor: { argb: "FFE8EEF5" },
    });

    const dataRow = sheet!.getRow(2);
    expect(dataRow.getCell(1).value).toBe(failedRow.casePath);
    expect(dataRow.getCell(2).value).toBe(failedRow.displayName);
    expect(dataRow.getCell(3).value).toBe(failedRow.summary);
    expect(dataRow.getCell(4).value).toBe("分析员 A（c10001）");
    expect(dataRow.getCell(5).value).toBe("用例问题已修改");
    expect(dataRow.getCell(6).value).toBe("测试数据字段已经失效");
    expect(dataRow.getCell(7).value).toEqual({
      text: "https://git.example/commit/abc123",
      hyperlink: "https://git.example/commit/abc123",
    });
    expect(dataRow.getCell(8).value).toBe("");
    expect(dataRow.getCell(9).value).toBe("已回归确认");
    expect(dataRow.getCell(5).dataValidation).toMatchObject({
      type: "list",
      allowBlank: true,
      formulae: ['"重跑通过,用例问题已修改,代码问题已提单"'],
    });
    expect(dataRow.getCell(10).value).toEqual({ text: shareLink, hyperlink: shareLink });
    expect(dataRow.height).toBe(20);
    expect(dataRow.getCell(2).font).toMatchObject({
      name: "Microsoft YaHei UI",
      bold: true,
    });
    expect(dataRow.getCell(5).fill).toMatchObject({
      type: "pattern",
      fgColor: { argb: "FFEFF6FF" },
    });
    expect(dataRow.getCell(3).alignment).toMatchObject({ vertical: "middle" });
    // OOXML 会省略 false 布尔属性；省略与 false 都表示禁用自动换行。
    expect(dataRow.getCell(3).alignment.wrapText).not.toBe(true);
    dataRow.eachCell((cell) => expect(cell.alignment.indent ?? 0).toBe(0));
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
    const sheet = workbook.getWorksheet("执行结果")!;
    expect(sheet.getRow(1).values).toContain("执行结果");
    expect(sheet.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FFE8EEF5" } });
    expect(sheet.getCell("C2").fill).toMatchObject({ fgColor: { argb: "FFFEF2F2" } });
    expect(sheet.getCell("G2").value).toBe(60);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1, showGridLines: false });
    expect(sheet.autoFilter).toBe("A1:H1");
    sheet.getRow(2).eachCell((cell) => expect(cell.alignment.indent ?? 0).toBe(0));
    expect(sheet.getColumn(5).width).toBeGreaterThanOrEqual(failedRow.startedAt!.length + 2);
    expect(sheet.getColumn(7).width).toBeLessThan(sheet.getColumn(5).width!);
    expect(sheet.getColumn(3).width).toBeLessThan(sheet.getColumn(1).width!);
  });

  it("adapts text columns to the exported content without letting long errors expand the sheet", async () => {
    const exportRow = async (row: RunBatchExportRow) =>
      (
        await loadWorkbook(
          (
            await buildRunBatchExportWorkbook({
              batchId: "batch-123456789",
              scope: "all",
              rows: [row],
              shareLinks: new Map(),
            })
          ).buffer,
        )
      ).getWorksheet("执行结果")!;
    const short = await exportRow({ ...failedRow, casePath: "example.Test", summary: "失败" });
    const long = await exportRow({
      ...failedRow,
      casePath: "com.example.payment.regression.validation.SubmitPaymentTest",
      summary: "失败堆栈".repeat(1_000),
    });
    expect(short.getColumn(1).width).toBeLessThan(short.getColumn(4).width!);
    expect(long.getColumn(2).width).toBeGreaterThan(short.getColumn(2).width!);
    expect(long.getColumn(5).width).toBeLessThanOrEqual(52);
    expect(long.getCell("E2").value).toBe("失败堆栈".repeat(1_000));
  });

  it("writes a completed rerun public log into the proof column", async () => {
    const proofLink = "https://autoforge.example/share/attempt-log/rerun-proof";
    const rerunClaim: FailureAnalysisClaim = {
      ...completedClaim,
      category: "rerun_passed",
      rerunProofAttemptId: "attempt-rerun",
      rerunProofUrl: "/share/attempt-log/rerun-proof",
    };
    const result = await buildRunBatchExportWorkbook({
      batchId: "batch-123456789",
      template: "failure-analysis",
      scope: "final",
      rows: [failedRow],
      shareLinks: new Map(),
      analysisClaims: new Map([["attempt-failed", rerunClaim]]),
      analysisProofLinks: new Map([[rerunClaim.id, proofLink]]),
    });

    const sheet = (await loadWorkbook(result.buffer)).getWorksheet("失败用例分析清单")!;
    expect(sheet.getRow(2).getCell(5).value).toBe("重跑通过");
    expect(sheet.getRow(2).getCell(8).value).toEqual({
      text: "重跑通过日志",
      hyperlink: proofLink,
    });
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
