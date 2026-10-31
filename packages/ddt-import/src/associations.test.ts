import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseDdtAssociationSpreadsheet } from "./associations";
function bytes(sheets: Record<string, unknown[][]>) {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
describe("SR association workbook validation", () => {
  it("reads all four sections, literal strings, Chinese names, leading zero SRs and explicit clears", async () => {
    const result = await parseDdtAssociationSpreadsheet(
      bytes({
        候选测试类: [["测试类路径", "异常说明"], ["com.example.Wallet"]],
        分类执行类: [
          ["需求分类", "测试类路径", "异常说明"],
          ["钱包", "com.example.Wallet"],
        ],
        SR需求分类: [
          ["SR", "需求分类", "异常说明"],
          ["0007", "钱包"],
          ["中文SR", ""],
        ],
        SR直接关联: [
          ["SR", "测试类路径", "异常说明"],
          ["=literal", "com.example.Wallet"],
          ["CLEAR", ""],
        ],
        说明: [["配置说明"]],
      }),
      "config.xlsx",
    );
    expect(result.issueCount).toBe(0);
    expect(result.rows).toHaveLength(6);
    expect(result.rows.slice(2)).toMatchObject([
      { srNum: "0007", categoryName: "钱包" },
      { srNum: "中文SR", categoryName: "" },
      { srNum: "=literal", className: "com.example.Wallet" },
      { srNum: "CLEAR", className: "" },
    ]);
  });
  it("rejects duplicate SRs across both worksheets and source conflict warnings with locations", async () => {
    const result = await parseDdtAssociationSpreadsheet(
      bytes({
        SR需求分类: [
          ["SR", "需求分类", "异常说明"],
          ["Wallet", "钱包"],
          ["other", "", "历史冲突"],
        ],
        SR直接关联: [
          ["SR", "测试类路径", "异常说明"],
          [" wallet ", "com.Wallet"],
        ],
      }),
      "config.xlsx",
    );
    expect(result.issueCount).toBe(2);
    expect(result.issues).toMatchObject([
      { sheetName: "SR需求分类", rowNumber: 3 },
      { sheetName: "SR直接关联", rowNumber: 2 },
    ]);
  });
  it("rejects formulas even without cached values and extra data columns", async () => {
    const result = await parseDdtAssociationSpreadsheet(
      bytes({
        候选测试类: [
          ["测试类路径", "异常说明"],
          [{ t: "n", f: "1+1" }],
          ["com.Valid", "", "unexpected"],
        ],
      }),
      "config.xlsx",
    );
    expect(result.issueCount).toBe(2);
    expect(result.rows).toEqual([]);
  });
  it("requires header names and reports a header-only template as empty", async () => {
    const wrong = await parseDdtAssociationSpreadsheet(
      bytes({
        SR需求分类: [
          ["SR", "标签"],
          ["A", "B"],
        ],
      }),
      "x.xlsx",
    );
    expect(wrong.issues[0]?.rowNumber).toBe(1);
    const empty = await parseDdtAssociationSpreadsheet(
      bytes({ SR需求分类: [["SR", "需求分类"]] }),
      "x.xlsx",
    );
    expect(empty.issueCount).toBe(1);
  });
  it("rejects a DDT workbook or unknown worksheet rather than ignoring its content", async () => {
    await expect(
      parseDdtAssociationSpreadsheet(
        bytes({
          用例: [
            ["CaseID", "srNum"],
            ["A", "SR"],
          ],
        }),
        "x.xlsx",
      ),
    ).rejects.toThrow();
    await expect(
      parseDdtAssociationSpreadsheet(
        bytes({
          SR需求分类: [
            ["SR", "需求分类"],
            ["A", "B"],
          ],
          误拼名称: [["data"]],
        }),
        "x.xlsx",
      ),
    ).rejects.toThrow("模板以外");
    await expect(parseDdtAssociationSpreadsheet(new Uint8Array(), "x.csv")).rejects.toThrow("XLSX");
  });
});
