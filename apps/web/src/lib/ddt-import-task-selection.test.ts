import { ddtImportCaseIdsSchema } from "@autoforge/contracts";
import { describe, expect, it } from "vitest";
import { canAddDdtImportToTask, ddtImportTaskCaseIds } from "./ddt-import-task-selection";

describe("import ledger task selection", () => {
  it("preserves long historical IDs for downloads but reports IDs unsupported by task membership before submitting", () => {
    const ledger = { items: [{ caseId: "长".repeat(600), outcome: "inserted" }] };
    expect(ddtImportCaseIdsSchema.parse(ledger)).toEqual(ledger);
    expect(() => ddtImportTaskCaseIds(ledger)).toThrow("超出任务接口支持的格式");
  });
  it("retains exact Chinese CaseIDs from every committed outcome and excludes duplicates", () => {
    const items = ["inserted", "updated", "unchanged", "skipped"].map((outcome, index) => ({
      caseId: `钱包-${index}`,
      outcome,
    }));
    expect(ddtImportTaskCaseIds({ items: [...items, items[0]] })).toEqual([
      "钱包-0",
      "钱包-1",
      "钱包-2",
      "钱包-3",
    ]);
  });
  it.each([
    { items: [] },
    { items: [{ caseId: "A", outcome: "failed" }] },
    { items: [{ caseId: "", outcome: "inserted" }] },
  ])("rejects empty or invalid ledgers", ({ items }) => {
    expect(() => ddtImportTaskCaseIds({ items })).toThrow();
  });
  it("allows settled partial imports with committed cases and rejects in-progress or empty jobs", () => {
    const counts = { insertedCount: 1, updatedCount: 0, unchangedCount: 0, skippedCount: 0 };
    for (const status of ["succeeded", "partially_succeeded", "failed", "cancelled"] as const)
      expect(canAddDdtImportToTask({ status, ...counts })).toBe(true);
    for (const status of ["previewed", "queued", "running", "cancel_requested"] as const)
      expect(canAddDdtImportToTask({ status, ...counts })).toBe(false);
    expect(canAddDdtImportToTask({ status: "succeeded", ...counts, insertedCount: 0 })).toBe(false);
  });
});
