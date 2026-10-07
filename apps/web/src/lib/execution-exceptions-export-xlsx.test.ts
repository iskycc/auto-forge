import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionExceptionPage } from "@autoforge/contracts";
vi.mock("server-only", () => ({}));
import { createExecutionExceptionWorkbookStream } from "./execution-exceptions-export-xlsx";

function createPage(index = 0): ExecutionExceptionPage {
  return {
    batchId: "batch",
    status: "failed",
    expectedStatus: "failed",
    consistent: true,
    abnormalRuns: 1,
    items: [
      {
        id: `run:${index}`,
        kind: "run",
        round: 2,
        attemptNumber: null,
        runId: String(index),
        caseName: "=SUM(1,2)",
        className: "example.Case",
        resultCode: "QUEUE_TIMEOUT",
        summary: "原因说明\n" + "完整说明".repeat(500),
        occurredAt: "2026-10-06T00:00:00.000Z",
        affectsBatchStatus: true,
      },
    ],
  };
}
async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const load = workbook.xlsx.load.bind(workbook.xlsx) as unknown as (
    content: Uint8Array,
  ) => Promise<ExcelJS.Workbook>;
  await load(buffer);
  return workbook;
}
describe("execution exception Excel downloads", () => {
  it("streams every page with full text, history, recovery, timezone and the common export style", async () => {
    const firstPage = createPage();
    async function* pages() {
      yield firstPage;
      const page = createPage(1);
      page.items[0] = {
        ...page.items[0]!,
        kind: "recovery",
        caseName: null,
        className: null,
        resultCode: "JENKINS_ROUND_RECOVERY_FAILED",
        affectsBatchStatus: false,
      };
      page.items.push({
        ...createPage(2).items[0]!,
        kind: "attempt",
        round: 4,
        attemptNumber: 3,
        resultCode: "EXECUTION_TIMEOUT",
      });
      yield page;
    }
    const generated = createExecutionExceptionWorkbookStream({
      firstPage,
      pages: pages(),
      timeZone: "Asia/Shanghai",
    });
    const [, buffer] = await Promise.all([generated.completion, collect(generated.stream)]);
    const workbook = await loadWorkbook(buffer);
    const sheet = workbook.getWorksheet("异常原因")!;
    expect(sheet.actualRowCount).toBe(4);
    expect(sheet.getCell("B2").value).toBe("用例终态");
    expect(sheet.getCell("C2").value).toBeNull();
    expect(sheet.getCell("D2").value).toBe("=SUM(1,2)");
    expect(sheet.getCell("D2").type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell("H2").value).toBe(firstPage.items[0]!.summary);
    expect(sheet.getCell("J2").value).toBe("2026-10-06 08:00:00");
    expect(sheet.getCell("K2").value).toBe(firstPage.items[0]!.occurredAt);
    expect(sheet.getCell("B3").value).toBe("轮次环境恢复");
    expect(sheet.getCell("I3").value).toBe("历史异常");
    expect(sheet.getCell("A4").value).toBe(4);
    expect(sheet.getCell("B4").value).toBe("用例执行");
    expect(sheet.getCell("C4").value).toBe(3);
    expect(sheet.getCell("G4").value).toBe("EXECUTION_TIMEOUT");
    expect(sheet.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FFE8EEF5" } });
    expect(sheet.getCell("A3").fill).toMatchObject({ fgColor: { argb: "FFF8FAFC" } });
    expect(sheet.getColumn(8).width).toBeGreaterThan(sheet.getColumn(1).width!);
    expect(sheet.getCell("H2").alignment.wrapText).toBe(true);
    sheet.getRow(2).eachCell((cell) => expect(cell.alignment.indent ?? 0).toBe(0));
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1, xSplit: 3 });
    expect(workbook.getWorksheet("判定概览")!.getCell("B7").value).toBe(3);
  });
  it("returns a useful empty workbook with the status mismatch preserved", async () => {
    const firstPage = {
      ...createPage(),
      items: [],
      expectedStatus: "succeeded" as const,
      consistent: false,
    };
    async function* pages() {
      yield firstPage;
    }
    const generated = createExecutionExceptionWorkbookStream({
      firstPage,
      pages: pages(),
      timeZone: "UTC",
    });
    const [, buffer] = await Promise.all([generated.completion, collect(generated.stream)]);
    const workbook = await loadWorkbook(buffer);
    expect(workbook.getWorksheet("异常原因")!.actualRowCount).toBe(1);
    expect(workbook.getWorksheet("判定概览")!.getCell("B5").value).toBe("不一致");
  });
  it("propagates a later-page failure instead of completing a partial Excel file", async () => {
    const failure = new Error("second page unavailable");
    async function* pages() {
      yield createPage();
      throw failure;
    }
    const generated = createExecutionExceptionWorkbookStream({
      firstPage: createPage(),
      pages: pages(),
      timeZone: "UTC",
    });
    const results = await Promise.allSettled([generated.completion, collect(generated.stream)]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
  });
  it("stops reading more pages when the request is cancelled", async () => {
    const controller = new AbortController();
    let requestedPages = 0;
    async function* pages() {
      yield createPage();
      requestedPages++;
      yield createPage(1);
    }
    const generated = createExecutionExceptionWorkbookStream({
      firstPage: createPage(),
      pages: pages(),
      timeZone: "UTC",
      signal: controller.signal,
    });
    const content = collect(generated.stream);
    controller.abort(new Error("download closed"));
    const results = await Promise.allSettled([generated.completion, content]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(requestedPages).toBe(0);
  });
});
