import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { buildExportWorkbook, parseDdtUpload, parseSpreadsheet } from "../src";

describe("DDT spreadsheet compatibility", () => {
  it("round-trips standard and multi-step journey cases", () => {
    const workbook = buildExportWorkbook([
      { CaseID: "LOGIN-1", srNum: "AUTH", username: "alice", enabled: true },
      {
        CaseID: "ORDER-1",
        srNum: "ORDER",
        用户旅程: {
          step1: { CaseID: "ORDER-1", srNum: "ORDER", action: "create" },
          step2: { CaseID: "ORDER-1", srNum: "ORDER", action: "pay" },
        },
      },
    ]);

    const parsed = parseSpreadsheet(workbook, "cases.xlsx");
    expect(parsed.rows).toEqual([
      expect.objectContaining({ CaseID: "LOGIN-1", srNum: "AUTH", username: "alice" }),
      expect.objectContaining({
        CaseID: "ORDER-1",
        用户旅程: {
          step1: expect.objectContaining({ action: "create" }),
          step2: expect.objectContaining({ action: "pay" }),
        },
      }),
    ]);
  });

  it("imports UTF-8 Chinese CSV names from a ZIP archive", async () => {
    const archive = zipSync({
      "订单/回归用例.csv": new TextEncoder().encode(
        "CaseID,srNum,场景\nORDER-中文,ORDER,下单并支付\n",
      ),
    });

    const files = await parseDdtUpload({
      fileName: "中文数据.zip",
      mediaType: "application/zip",
      content: archive,
    });
    expect(files).toEqual([
      expect.objectContaining({
        fileName: "中文数据.zip / 订单/回归用例.csv",
        archiveEntryName: "订单/回归用例.csv",
        rows: [expect.objectContaining({ CaseID: "ORDER-中文", 场景: "下单并支付" })],
      }),
    ]);
  });
});
