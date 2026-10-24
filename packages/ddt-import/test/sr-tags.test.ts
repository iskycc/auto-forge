import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { parseSrTagSpreadsheet } from "../src/sr-tags";
function workbook(sheets: Record<string, unknown[][]>) {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
describe("SR tag spreadsheets", () => {
  it("skips headers and blank rows, permits repeated SRs and reuse of tags on other SRs", () => {
    const parsed = parseSrTagSpreadsheet(
      workbook({
        分类: [["SR", "标签"], ["钱包SR", "Wallet"], ["钱包SR", "Smoke"], [], ["其他SR", "Wallet"]],
      }),
      "labels.xlsx",
    );
    expect(parsed.issueCount).toBe(0);
    expect(parsed.rowCount).toBe(3);
    expect(
      parsed.rows.map(({ srNum, tagName, rowNumber }) => ({ srNum, tagName, rowNumber })),
    ).toEqual([
      { srNum: "钱包SR", tagName: "Wallet", rowNumber: 2 },
      { srNum: "钱包SR", tagName: "Smoke", rowNumber: 3 },
      { srNum: "其他SR", tagName: "Wallet", rowNumber: 5 },
    ]);
  });
  it("rejects duplicate normalized pairs across sheets and reports both source locations", () => {
    const parsed = parseSrTagSpreadsheet(
      workbook({
        A: [
          ["SR", "Tag"],
          [" SR-1 ", "Wallet"],
        ],
        B: [
          ["sr", "标签"],
          ["sr-1", " wallet "],
        ],
      }),
      "labels.xlsx",
    );
    expect(parsed.issueCount).toBe(1);
    expect(parsed.issues[0]).toMatchObject({ sheetName: "B", rowNumber: 2 });
    expect(parsed.issues[0]!.reason).toContain("A 第 2 行");
  });
  it.each([
    { rows: [["SR-1", "Wallet"]] },
    {
      rows: [
        ["标签", "SR"],
        ["Wallet", "SR-1"],
      ],
    },
  ])(
    "requires an explicit first-row header instead of silently dropping a data row",
    ({ rows }) => {
      const parsed = parseSrTagSpreadsheet(workbook({ 数据: rows }), "labels.xlsx");
      expect(parsed.issues[0]).toMatchObject({ rowNumber: 1 });
      expect(parsed.issues[0]!.reason).toContain("第一行必须是表头");
    },
  );
  it("reports incomplete rows and extra columns without importing them", () => {
    const parsed = parseSrTagSpreadsheet(
      workbook({
        Data: [
          ["SR", "标签"],
          ["SR-1", ""],
          ["", "Wallet"],
          ["SR-2", "Smoke", "unexpected"],
        ],
      }),
      "labels.xlsx",
    );
    expect(parsed.issueCount).toBe(3);
    expect(parsed.rows).toEqual([]);
  });
  it("preserves formatted numeric SR identifiers and accepts BOM CSV headers", () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["SR", "标签"],
      [7, "Wallet"],
    ]);
    sheet.A2!.z = "0000";
    XLSX.utils.book_append_sheet(book, sheet, "Data");
    expect(
      parseSrTagSpreadsheet(
        XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer,
        "labels.xlsx",
      ).rows[0]!.srNum,
    ).toBe("0007");
    expect(
      parseSrTagSpreadsheet(Buffer.from("\uFEFFSR,标签\r\n钱包SR,Wallet\r\n"), "labels.csv")
        .rows[0]!.srNum,
    ).toBe("钱包SR");
  });
  it("preserves leading zeros in CSV SR identifiers and labels", () => {
    const parsed = parseSrTagSpreadsheet(Buffer.from("SR,标签\n0007,001\n"), "labels.csv");
    expect(parsed.rows[0]).toMatchObject({ srNum: "0007", tagName: "001" });
  });
  it("rejects formula cells and empty templates", () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["SR", "标签"],
      ["SR-1", "Wallet"],
    ]);
    sheet.B2 = { t: "s", v: "Wallet", f: '"Wallet"' };
    XLSX.utils.book_append_sheet(book, sheet, "Data");
    expect(
      parseSrTagSpreadsheet(
        XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer,
        "labels.xlsx",
      ).issues[0]!.reason,
    ).toContain("不支持公式");
    expect(
      parseSrTagSpreadsheet(workbook({ Data: [["SR", "标签"]] }), "labels.xlsx").issueCount,
    ).toBe(1);
  });
});
