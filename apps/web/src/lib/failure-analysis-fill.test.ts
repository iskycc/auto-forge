import { describe, expect, it } from "vitest";
import { fillAnalysisColumn, type AnalysisSheetDraft } from "./failure-analysis-fill";

const draft = (remark: string): AnalysisSheetDraft => ({
  category: "code_issue_filed",
  issueDescription: "问题",
  caseFixEvidence: "",
  ticketReference: "BUG-1",
  remark,
});
describe("analysis spreadsheet fill", () => {
  it("fills one field downwards without copying identity, proofs or other fields", () => {
    const result = fillAnalysisColumn({
      rowIds: ["a", "b", "c"],
      drafts: { a: draft("同一原因"), b: draft("原备注"), c: draft("") },
      sourceIndex: 0,
      targetIndex: 2,
      field: "remark",
      editable: new Set(["a", "b", "c"]),
    });
    expect(result.updatedIds).toEqual(["b", "c"]);
    expect(result.drafts.b).toEqual({ ...draft("原备注"), remark: "同一原因" });
    expect(result.drafts.a).toEqual(draft("同一原因"));
  });
  it("skips completed or other people's claims and reports the skipped rows", () => {
    const result = fillAnalysisColumn({
      rowIds: ["a", "b", "c", "d"],
      drafts: { a: draft("复制"), b: draft("保留"), c: draft("保留"), d: draft("") },
      sourceIndex: 0,
      targetIndex: 3,
      field: "remark",
      editable: new Set(["a", "d"]),
    });
    expect(result.updatedIds).toEqual(["d"]);
    expect(result.skippedCount).toBe(2);
    expect(result.drafts.b?.remark).toBe("保留");
  });
  it.each([-1, 0, 4])("does not fill an invalid or non-downward target %s", (targetIndex) => {
    expect(
      fillAnalysisColumn({
        rowIds: ["a", "b"],
        drafts: { a: draft("x"), b: draft("") },
        sourceIndex: 0,
        targetIndex,
        field: "remark",
        editable: new Set(["a", "b"]),
      }).updatedIds,
    ).toEqual([]);
  });
  it("does not mutate the source snapshot or fill from a read-only cell", () => {
    const drafts = { a: draft("x"), b: draft("") };
    const result = fillAnalysisColumn({
      rowIds: ["a", "b"],
      drafts,
      sourceIndex: 0,
      targetIndex: 1,
      field: "category",
      editable: new Set(["b"]),
    });
    expect(result.drafts).toBe(drafts);
    expect(drafts.b.remark).toBe("");
  });
});
