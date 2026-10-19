import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { DdtDuplicateColumnsError, parseDdtUpload, parseSpreadsheet } from "../src";

function workbookContent(sheets: Record<string, unknown[][]>): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("automatic duplicate DDT column handling", () => {
  it.each(["csv", "xlsx"])("drops blank duplicates and identical columns in %s", (extension) => {
    const matrix = [
      [
        "CaseID",
        "caseid",
        "srNum",
        "srnum",
        "环境",
        "环境",
        "Owner",
        "owner",
        "全空",
        "全空",
        "保留空列",
      ],
      ["", "中文用例-1", "CORE", "CORE", " ", "生产", "alice", "alice", " ", "", ""],
      ["", "中文用例-2", "CORE", "CORE", "", "测试", "bob", "bob", "", "", ""],
    ];
    const content =
      extension === "csv"
        ? Buffer.from(matrix.map((row) => row.join(",")).join("\n"))
        : workbookContent({ data: matrix });
    const parsed = parseSpreadsheet(content, `cases.${extension}`);
    expect(parsed.columns).toEqual(["CaseID", "srNum", "环境", "Owner", "全空", "保留空列"]);
    expect(parsed.rows).toEqual([
      {
        CaseID: "中文用例-1",
        srNum: "CORE",
        环境: "生产",
        Owner: "alice",
        全空: " ",
        保留空列: "",
      },
      { CaseID: "中文用例-2", srNum: "CORE", 环境: "测试", Owner: "bob", 全空: "", 保留空列: "" },
    ]);
  });

  it("keeps zero, false and values beyond the preview sample when dropping blanks", () => {
    const content = workbookContent({
      data: [
        ["CaseID", "srNum", "数值", "数值", "开关", "开关", "最后一行", "最后一行"],
        ...Array.from({ length: 12 }, (_, index) => [
          `CASE-${index}`,
          "CORE",
          "",
          0,
          false,
          "",
          "",
          index === 11 ? "保留" : "",
        ]),
      ],
    });
    const parsed = parseSpreadsheet(content, "values.xlsx");
    expect(parsed.columns).toEqual(["CaseID", "srNum", "数值", "开关", "最后一行"]);
    expect(parsed.rows).toHaveLength(12);
    expect(parsed.rows[11]).toMatchObject({ 数值: "0", 开关: "FALSE", 最后一行: "保留" });
  });

  it.each([
    ["first", "second"],
    [" a", "a"],
    ["false", "0"],
  ])("requires confirmation for different values %j and %j", (left, right) => {
    expect(() =>
      parseSpreadsheet(
        Buffer.from(`CaseID,srNum,字段,字段\nCASE-1,CORE,${left},${right}\n`),
        "different.csv",
      ),
    ).toThrow(DdtDuplicateColumnsError);
  });

  it("compares all rows rather than the first eight samples or the set of values", () => {
    const rows = Array.from({ length: 12 }, (_, index) => [
      `CASE-${index}`,
      "CORE",
      `value-${index}`,
      index >= 10 ? `value-${21 - index}` : `value-${index}`,
    ]);
    expect(() =>
      parseSpreadsheet(
        workbookContent({ data: [["CaseID", "srNum", "环境", "环境"], ...rows] }),
        "late-difference.xlsx",
      ),
    ).toThrow(DdtDuplicateColumnsError);
  });

  it("only reports distinct populated columns and preserves original positions for manual resolution", () => {
    const content = Buffer.from("CaseID,srNum,环境,环境,环境,环境\nCASE-1,CORE,,测试,测试,生产\n");
    let conflict: DdtDuplicateColumnsError | undefined;
    try {
      parseSpreadsheet(content, "mixed.csv");
    } catch (error) {
      if (!(error instanceof DdtDuplicateColumnsError)) throw error;
      conflict = error;
    }
    expect(conflict?.conflicts[0]?.columns.map((column) => column.columnIndex)).toEqual([3, 5]);
    const parsed = parseSpreadsheet(content, "mixed.csv", [
      { sheetName: "Sheet1", columnIndex: 5, resolvedName: "目标环境" },
    ]);
    expect(parsed.rows).toEqual([
      { CaseID: "CASE-1", srNum: "CORE", 环境: "测试", 目标环境: "生产" },
    ]);
    expect(() =>
      parseSpreadsheet(content, "mixed.csv", [
        { sheetName: "Sheet1", columnIndex: 3, resolvedName: "环境", deleteColumn: true },
        { sheetName: "Sheet1", columnIndex: 5, resolvedName: "环境", deleteColumn: true },
      ]),
    ).toThrow("至少需要保留一列");
  });

  it("keeps explicitly renamed copies and rejects deletion of an entire duplicate group", () => {
    const content = Buffer.from("CaseID,srNum,环境,环境\nCASE-1,CORE,生产,生产\n");
    expect(
      parseSpreadsheet(content, "manual.csv", [
        { sheetName: "Sheet1", columnIndex: 3, resolvedName: "备份环境" },
      ]).rows,
    ).toEqual([{ CaseID: "CASE-1", srNum: "CORE", 环境: "生产", 备份环境: "生产" }]);
    expect(() =>
      parseSpreadsheet(content, "manual.csv", [
        { sheetName: "Sheet1", columnIndex: 2, resolvedName: "环境", deleteColumn: true },
        { sheetName: "Sheet1", columnIndex: 3, resolvedName: "环境", deleteColumn: true },
      ]),
    ).toThrow("至少需要保留一列");
  });

  it("also resolves identical values when a manual rename reveals another duplicate name", () => {
    const content = Buffer.from("CaseID,srNum,环境,环境,备份\nCASE-1,CORE,测试,生产,生产\n");
    const parsed = parseSpreadsheet(content, "rename.csv", [
      { sheetName: "Sheet1", columnIndex: 3, resolvedName: "备份" },
    ]);
    expect(parsed.columns).toEqual(["CaseID", "srNum", "环境", "备份"]);
    expect(parsed.rows).toEqual([{ CaseID: "CASE-1", srNum: "CORE", 环境: "测试", 备份: "生产" }]);
  });

  it("handles each journey sheet independently without merging different field names", () => {
    const parsed = parseSpreadsheet(
      workbookContent({
        step1: [
          ["caseid", "CaseID", "srNum", "环境", "环境", "目标"],
          ["中文-1", "中文-1", "CORE", "", "测试", "测试"],
        ],
        step2: [
          ["CaseID", "srNum", "环境", "环境"],
          ["中文-1", "CORE", "生产", "生产"],
        ],
      }),
      "journey.xlsx",
    );
    expect(parsed.rows).toEqual([
      {
        CaseID: "中文-1",
        srNum: "CORE",
        用户旅程: {
          step1: { CaseID: "中文-1", srNum: "CORE", 环境: "测试", 目标: "测试" },
          step2: { CaseID: "中文-1", srNum: "CORE", 环境: "生产" },
        },
      },
    ]);
  });

  it("auto-resolves ZIP entries independently and still reports genuine conflicts", async () => {
    const files = await parseDdtUpload({
      fileName: "cases.zip",
      mediaType: "application/zip",
      content: zipSync({
        "空列.csv": new TextEncoder().encode("CaseID,srNum,环境,环境\nCASE-A,CORE,,生产\n"),
        "相同.csv": new TextEncoder().encode("CaseID,srNum,环境,环境\nCASE-B,CORE,测试,测试\n"),
        "不同.csv": new TextEncoder().encode("CaseID,srNum,环境,环境\nCASE-C,CORE,测试,生产\n"),
      }),
    });
    expect(files[0]).toMatchObject({ archiveEntryName: "空列.csv", rows: [{ 环境: "生产" }] });
    expect(files[1]).toMatchObject({ archiveEntryName: "相同.csv", rows: [{ 环境: "测试" }] });
    expect(files[0]?.columnConflicts).toBeUndefined();
    expect(files[1]?.columnConflicts).toBeUndefined();
    expect(files[2]?.columnConflicts).toHaveLength(1);
  });
});
