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

  it("applies the configured spreadsheet limit to each ZIP archive", async () => {
    const archive = zipSync({
      "a.csv": new TextEncoder().encode("CaseID,srNum\na,A\n"),
      "b.csv": new TextEncoder().encode("CaseID,srNum\nb,B\n"),
    });
    const upload = {
      fileName: "cases.zip",
      mediaType: "application/zip",
      content: archive,
    };

    await expect(parseDdtUpload(upload, { maximumZipSpreadsheets: 1 })).rejects.toThrow(
      "ZIP 中可导入的表格超过 1 个的配置上限",
    );
    await expect(parseDdtUpload(upload, { maximumZipSpreadsheets: 2 })).resolves.toHaveLength(2);
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

  it("keeps canonical identity names in the suggested duplicate-column resolution", () => {
    const content = Buffer.from(
      "caseid,srnum,CaseID,srNum\nwrong-id,wrong-sr,CASE-1,CORE\n",
      "utf8",
    );

    let duplicateColumns: DdtDuplicateColumnsError | undefined;
    try {
      parseSpreadsheet(content, "identity-columns.csv");
    } catch (error) {
      if (error instanceof DdtDuplicateColumnsError) duplicateColumns = error;
      else throw error;
    }
    expect(duplicateColumns?.conflicts).toEqual([
      expect.objectContaining({
        normalizedName: "caseid",
        columns: [
          expect.objectContaining({ columnIndex: 0, suggestedName: "caseid_2" }),
          expect.objectContaining({ columnIndex: 2, suggestedName: "CaseID" }),
        ],
      }),
      expect.objectContaining({
        normalizedName: "srnum",
        columns: [
          expect.objectContaining({ columnIndex: 1, suggestedName: "srnum_2" }),
          expect.objectContaining({ columnIndex: 3, suggestedName: "srNum" }),
        ],
      }),
    ]);
  });

  it("suggests canonical identity names when duplicate headers use only non-canonical casing", () => {
    const content = Buffer.from(
      "caseid,srnum,CASEID,SRNUM\nCASE-1,CORE,wrong-id,wrong-sr\n",
      "utf8",
    );

    let duplicateColumns: DdtDuplicateColumnsError | undefined;
    try {
      parseSpreadsheet(content, "non-canonical-identity-columns.csv");
    } catch (error) {
      if (error instanceof DdtDuplicateColumnsError) duplicateColumns = error;
      else throw error;
    }
    expect(duplicateColumns?.conflicts).toEqual([
      expect.objectContaining({
        normalizedName: "caseid",
        columns: [
          expect.objectContaining({ columnIndex: 0, suggestedName: "CaseID" }),
          expect.objectContaining({ columnIndex: 2, suggestedName: "CASEID_2" }),
        ],
      }),
      expect.objectContaining({
        normalizedName: "srnum",
        columns: [
          expect.objectContaining({ columnIndex: 1, suggestedName: "srNum" }),
          expect.objectContaining({ columnIndex: 3, suggestedName: "SRNUM_2" }),
        ],
      }),
    ]);
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
    ).resolves.toEqual([
      expect.objectContaining({
        archiveEntryName: "回归/冲突.csv",
        errorSummary: expect.stringContaining("发现重复列名"),
        columnConflicts: [expect.objectContaining({ archiveEntryName: "回归/冲突.csv" })],
      }),
    ]);

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

  it("keeps every ZIP entry visible when valid, conflicted and invalid sheets are mixed", async () => {
    const archive = zipSync({
      "valid.csv": new TextEncoder().encode("CaseID,srNum,name\nVALID,CORE,ok\n"),
      "conflicted.csv": new TextEncoder().encode(
        "CaseID,srNum,owner,OWNER\nCONFLICT,CORE,alice,bob\n",
      ),
      "invalid.csv": new TextEncoder().encode("CaseID,name\nINVALID,missing srNum\n"),
    });

    const files = await parseDdtUpload({
      fileName: "mixed.zip",
      mediaType: "application/zip",
      content: archive,
    });

    expect(files).toHaveLength(3);
    expect(files.find((file) => file.archiveEntryName === "valid.csv")).toMatchObject({
      rows: [expect.objectContaining({ CaseID: "VALID" })],
    });
    expect(files.find((file) => file.archiveEntryName === "conflicted.csv")).toMatchObject({
      rows: [],
      errorSummary: expect.stringContaining("发现重复列名"),
      columnConflicts: [expect.objectContaining({ archiveEntryName: "conflicted.csv" })],
    });
    expect(files.find((file) => file.archiveEntryName === "invalid.csv")).toMatchObject({
      rows: [],
      errorSummary: expect.stringContaining("缺少必需列 srNum"),
    });
  });
});
