import type { CaseSuiteExportRow } from "@autoforge/application";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let createCaseSuiteExportWorkbookStream: typeof import("./case-suite-export-xlsx").createCaseSuiteExportWorkbookStream;
let caseSuiteExportFilename: typeof import("./case-suite-export-xlsx").caseSuiteExportFilename;
let caseSuiteExportContentDisposition: typeof import("./case-suite-export-xlsx").caseSuiteExportContentDisposition;

beforeAll(async () => {
  ({
    createCaseSuiteExportWorkbookStream,
    caseSuiteExportFilename,
    caseSuiteExportContentDisposition,
  } = await import("./case-suite-export-xlsx"));
});

describe("case suite XLSX export", () => {
  it("streams the requested class path and case name columns", async () => {
    const rows: CaseSuiteExportRow[] = [
      {
        memberId: "member-1",
        casePath: "com.example.payment.PaymentTest",
        displayName: "PaymentTest",
      },
      {
        memberId: "member-2",
        casePath: "com.example.order.OrderDdtTest",
        displayName: "ORDER-1001",
      },
    ];
    const generated = createCaseSuiteExportWorkbookStream(asAsyncRows(rows));
    const bufferPromise = collect(generated.stream);
    const [, buffer] = await Promise.all([generated.completion, bufferPromise]);

    const workbook = new ExcelJS.Workbook();
    // ExcelJS 4 的声明尚未适配 Node 24 泛型 Buffer，运行时支持 Uint8Array。
    const load = workbook.xlsx.load.bind(workbook.xlsx) as unknown as (
      content: Uint8Array,
    ) => Promise<ExcelJS.Workbook>;
    await load(buffer);
    const sheet = workbook.getWorksheet("任务用例");
    expect(sheet?.getRow(1).values).toEqual([undefined, "用例编号（类路径）", "用例名称"]);
    expect(sheet?.getRow(2).values).toEqual([
      undefined,
      "com.example.payment.PaymentTest",
      "PaymentTest",
    ]);
    expect(sheet?.getRow(3).values).toEqual([
      undefined,
      "com.example.order.OrderDdtTest",
      "ORDER-1001",
    ]);
    expect(sheet?.actualRowCount).toBe(3);
    expect(sheet?.getColumn(1).width).toBe(52);
    expect(sheet?.getColumn(2).width).toBe(36);
  });

  it("creates a safe Chinese filename and RFC 5987 disposition", () => {
    const filename = caseSuiteExportFilename('每日/冒烟:"任务"', "12345678-rest");
    expect(filename).toBe("每日-冒烟--任务--12345678-用例.xlsx");
    const disposition = caseSuiteExportContentDisposition(filename);
    expect(disposition).toContain('filename="case-suite-cases.xlsx"');
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe(filename);
  });
});

async function* asAsyncRows(
  rows: readonly CaseSuiteExportRow[],
): AsyncGenerator<CaseSuiteExportRow> {
  for (const row of rows) yield row;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
