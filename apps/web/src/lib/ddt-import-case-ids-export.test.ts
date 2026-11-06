import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { ddtImportCaseIdsCsv } from "./ddt-import-case-ids-export";

describe("DDT imported CaseID CSV download", () => {
  it("identifies UTF-8 to Excel before the Chinese header and CaseIDs", async () => {
    const items = [
      { caseId: "钱包支付-中文用例😀", outcome: "inserted" },
      { caseId: "跨境退款-用例二", outcome: "updated" },
    ];
    const file = ddtImportCaseIdsCsv(items);
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(file.type).toBe("text/csv;charset=utf-8");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe(
      'CaseID,结果\r\n"钱包支付-中文用例😀","inserted"\r\n"跨境退款-用例二","updated"\r\n',
    );
    expect(await readRows(bytes)).toEqual([
      ["CaseID", "结果"],
      ...items.map((item) => [item.caseId, item.outcome]),
    ]);
  });

  it("preserves quotes, commas, leading zeroes, Unicode and all import outcomes", async () => {
    const items = [
      { caseId: '中文,"引号"-001', outcome: "inserted" },
      { caseId: "000012345", outcome: "updated" },
      { caseId: "路由/支付?场景=成功", outcome: "unchanged" },
      { caseId: "空 格与扩展汉字𠮷", outcome: "skipped" },
    ];
    const bytes = Buffer.from(await ddtImportCaseIdsCsv(items).arrayBuffer());
    expect(await readRows(bytes)).toEqual([
      ["CaseID", "结果"],
      ...items.map((item) => [item.caseId, item.outcome]),
    ]);
  });

  it("keeps exactly one encoding marker and a header for an empty import", async () => {
    const bytes = Buffer.from(await ddtImportCaseIdsCsv([]).arrayBuffer());
    expect(bytes.toString("utf8")).toBe("\uFEFFCaseID,结果\r\n");
    expect(await readRows(bytes)).toEqual([["CaseID", "结果"]]);
  });
});

async function readRows(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  const sheet = await workbook.csv.read(Readable.from([bytes]), { map: (value) => value });
  const rows: unknown[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
}
