import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  buildExportWorkbook,
  DdtDuplicateColumnsError,
  parseDdtUpload,
  parseSpreadsheet,
} from "../src";

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

  it("reports duplicate column positions and applies a manual resolution", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["CaseID", "srNum", "owner", "Owner"],
        ["LOGIN-1", "AUTH", "alice", "quality-team"],
      ]),
      "data",
    );
    const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    let conflict: DdtDuplicateColumnsError | undefined;
    try {
      parseSpreadsheet(content, "duplicate-columns.xlsx");
    } catch (error) {
      if (error instanceof DdtDuplicateColumnsError) conflict = error;
      else throw error;
    }
    expect(conflict?.conflicts).toEqual([
      expect.objectContaining({
        sheetName: "data",
        normalizedName: "owner",
        columns: [
          expect.objectContaining({
            columnIndex: 2,
            originalName: "owner",
            nonEmptyCount: 1,
            sampleValues: [{ rowNumber: 2, value: "alice" }],
          }),
          expect.objectContaining({
            columnIndex: 3,
            originalName: "Owner",
            suggestedName: "Owner_2",
            nonEmptyCount: 1,
            sampleValues: [{ rowNumber: 2, value: "quality-team" }],
          }),
        ],
      }),
    ]);

    const parsed = parseSpreadsheet(content, "duplicate-columns.xlsx", [
      { sheetName: "data", columnIndex: 2, resolvedName: "owner" },
      { sheetName: "data", columnIndex: 3, resolvedName: "reviewTeam" },
    ]);
    expect(parsed.columns).toEqual(["CaseID", "srNum", "owner", "reviewTeam"]);
    expect(parsed.rows).toEqual([
      {
        CaseID: "LOGIN-1",
        srNum: "AUTH",
        owner: "alice",
        reviewTeam: "quality-team",
      },
    ]);

    const parsedAfterDeletion = parseSpreadsheet(content, "duplicate-columns.xlsx", [
      { sheetName: "data", columnIndex: 2, resolvedName: "owner" },
      { sheetName: "data", columnIndex: 3, resolvedName: "Owner", deleteColumn: true },
    ]);
    expect(parsedAfterDeletion.columns).toEqual(["CaseID", "srNum", "owner"]);
    expect(parsedAfterDeletion.rows).toEqual([
      { CaseID: "LOGIN-1", srNum: "AUTH", owner: "alice" },
    ]);
    expect(() =>
      parseSpreadsheet(content, "duplicate-columns.xlsx", [
        { sheetName: "data", columnIndex: 2, resolvedName: "owner", deleteColumn: true },
        { sheetName: "data", columnIndex: 3, resolvedName: "Owner", deleteColumn: true },
      ]),
    ).toThrow("至少需要保留一列");
  });

  it("applies duplicate column resolutions to a spreadsheet inside ZIP", async () => {
    const archive = zipSync({
      "回归/冲突.csv": new TextEncoder().encode(
        "CaseID,srNum,环境,环境\nCASE-ZIP,CORE,test,production\n",
      ),
    });

    await expect(
      parseDdtUpload({
        fileName: "冲突数据.zip",
        mediaType: "application/zip",
        content: archive,
      }),
    ).rejects.toMatchObject({
      code: "DDT_DUPLICATE_COLUMNS",
      conflicts: [expect.objectContaining({ archiveEntryName: "回归/冲突.csv" })],
    });

    const files = await parseDdtUpload({
      fileName: "冲突数据.zip",
      mediaType: "application/zip",
      content: archive,
      columnResolutions: [
        {
          archiveEntryName: "回归/冲突.csv",
          sheetName: "Sheet1",
          columnIndex: 3,
          resolvedName: "目标环境",
        },
      ],
    });
    expect(files[0]?.rows).toEqual([
      expect.objectContaining({ CaseID: "CASE-ZIP", 环境: "test", 目标环境: "production" }),
    ]);
  });
});
