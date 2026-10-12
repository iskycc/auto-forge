import { describe, expect, it } from "vitest";
import type { DdtImportColumnResolution } from "@autoforge/contracts";
import { parseDdtUpload, parseSpreadsheet } from "@autoforge/ddt-import";
import {
  columnResolutionIdentity,
  planBlankConflictColumnDeletion,
  type LocatedColumnConflict,
} from "./ddt-column-resolution";

function conflict(nonEmptyCounts: number[], name = "环境"): LocatedColumnConflict {
  return {
    uploadIndex: 0,
    uploadName: "cases.csv",
    sheetName: "data",
    normalizedName: name.toLowerCase(),
    columns: nonEmptyCounts.map((nonEmptyCount, index) => ({
      columnIndex: index + 2,
      originalName: name,
      currentName: name,
      suggestedName: index === 0 ? name : `${name}_${index + 1}`,
      nonEmptyCount,
      sampleValues: [],
    })),
  };
}

function draft(group: LocatedColumnConflict): DdtImportColumnResolution[] {
  return group.columns.map((column) => ({
    ...columnResolutionIdentity(group, column.columnIndex),
    resolvedName: column.suggestedName,
  }));
}

describe("blank duplicate column deletion", () => {
  it("uses full-sheet counts and keeps late values, zero and false through reparsing", async () => {
    const content = Buffer.from(
      "CaseID,srNum,环境,环境,数值,数值,布尔,布尔,全空,全空\n" +
        Array.from({ length: 12 }, (_, index) =>
          [
            `CASE-${index}`,
            "CORE",
            " ",
            index === 11 ? "late-value" : "",
            "",
            "0",
            "",
            "false",
            " ",
            "",
          ].join(","),
        ).join("\n"),
    );
    const preview = await parseDdtUpload({ fileName: "cases.csv", mediaType: "text/csv", content });
    const groups = preview[0]!.columnConflicts!.map((group) => ({
      ...group,
      uploadIndex: 0,
      uploadName: "cases.csv",
    }));
    expect(groups[0]?.columns.map((column) => column.nonEmptyCount)).toEqual([0, 1]);
    expect(groups[1]?.columns.map((column) => column.nonEmptyCount)).toEqual([0, 12]);
    expect(groups[2]?.columns.map((column) => column.nonEmptyCount)).toEqual([0, 12]);
    const planned = planBlankConflictColumnDeletion(groups.flatMap(draft), groups);
    expect(planned.deletedColumnCount).toBe(4);
    const parsed = parseSpreadsheet(content, "cases.csv", planned.resolutions);
    expect(parsed.columns).toEqual(["CaseID", "srNum", "环境", "数值", "布尔", "全空"]);
    expect(parsed.rows).toHaveLength(12);
    expect(parsed.rows[11]).toMatchObject({ 环境: "late-value", 数值: "0", 布尔: "false" });
  });

  it.each([
    { counts: [0, 3], deleted: [true, false] },
    { counts: [3, 0], deleted: [false, true] },
    { counts: [0, 0], deleted: [false, true] },
    { counts: [0, 0, 0], deleted: [false, true, true] },
    { counts: [0, 2, 0, 1], deleted: [true, false, true, false] },
  ])("deletes blanks in $counts while retaining at least one column", ({ counts, deleted }) => {
    const group = conflict(counts);
    const initial = draft(group);
    const snapshot = structuredClone(initial);
    const planned = planBlankConflictColumnDeletion(initial, [group]);
    expect(planned.resolutions.map((resolution) => resolution.deleteColumn === true)).toEqual(
      deleted,
    );
    expect(planned.deletedColumnCount).toBe(deleted.filter(Boolean).length);
    expect(initial).toEqual(snapshot);
    expect(planBlankConflictColumnDeletion(planned.resolutions, [group])).toEqual({
      resolutions: planned.resolutions,
      deletedColumnCount: 0,
    });
  });

  it("keeps populated columns even when no preview samples are present", () => {
    const group = conflict([1, 100]);
    const initial = draft(group);
    expect(planBlankConflictColumnDeletion(initial, [group])).toEqual({
      resolutions: initial,
      deletedColumnCount: 0,
    });
  });

  it("removes the suggested suffix from the sole surviving field", () => {
    const group = conflict([0, 1]);
    expect(
      planBlankConflictColumnDeletion(draft(group), [group]).resolutions[1]?.resolvedName,
    ).toBe("环境");
  });

  it("preserves manual names and deletions", () => {
    const group = conflict([0, 2, 3]);
    const initial = draft(group);
    initial[1]!.resolvedName = "生产环境";
    initial[2]!.deleteColumn = true;
    const planned = planBlankConflictColumnDeletion(initial, [group]);
    expect(planned.deletedColumnCount).toBe(1);
    expect(planned.resolutions[1]).toEqual(initial[1]);
    expect(planned.resolutions[2]).toEqual(initial[2]);
  });

  it.each(["CaseID", "srNum"])(
    "retains the canonical %s name when its first column is blank",
    (name) => {
      const group = conflict([0, 1], name);
      group.columns[1]!.currentName = name.toLowerCase();
      const planned = planBlankConflictColumnDeletion(draft(group), [group]);
      expect(planned.resolutions[0]?.deleteColumn).toBe(true);
      expect(planned.resolutions[1]?.resolvedName).toBe(name);
    },
  );

  it("keeps a canonical identity name on a later column in an entirely blank group", () => {
    const group = conflict([0, 0], "CaseID");
    group.columns[0]!.currentName = "caseid";
    group.columns[0]!.suggestedName = "caseid_2";
    group.columns[1]!.suggestedName = "CaseID";
    expect(
      planBlankConflictColumnDeletion(draft(group), [group]).resolutions[0]?.resolvedName,
    ).toBe("CaseID");
  });

  it("preserves canonical names when several populated identity columns remain", () => {
    const group = conflict([0, 1, 2], "srNum");
    const planned = planBlankConflictColumnDeletion(draft(group), [group]);
    expect(planned.resolutions.map((resolution) => resolution.resolvedName)).toEqual([
      "srNum",
      "srNum",
      "srNum_3",
    ]);
    expect(
      planned.resolutions
        .filter((resolution) => !resolution.deleteColumn)
        .map((resolution) => resolution.resolvedName),
    ).toEqual(["srNum", "srNum_3"]);
  });

  it("isolates files, ZIP entries and sheets with the same column positions", () => {
    const groups = [
      conflict([0, 1]),
      { ...conflict([1, 0]), uploadIndex: 1 },
      { ...conflict([1, 0]), archiveEntryName: "nested/cases.csv" },
      { ...conflict([1, 0]), sheetName: "step1" },
    ];
    const initial = groups.flatMap(draft);
    const planned = planBlankConflictColumnDeletion(initial, groups);
    expect(planned.deletedColumnCount).toBe(4);
    expect(planned.resolutions.map((resolution) => resolution.deleteColumn === true)).toEqual([
      true,
      false,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it("leaves manual deletion of every column for the existing validation to report", () => {
    const group = conflict([0, 0]);
    const initial = draft(group).map((resolution) => ({ ...resolution, deleteColumn: true }));
    expect(planBlankConflictColumnDeletion(initial, [group])).toEqual({
      resolutions: initial,
      deletedColumnCount: 0,
    });
  });
});
