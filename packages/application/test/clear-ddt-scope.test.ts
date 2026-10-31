import { expect, it, vi } from "vitest";
import { DdtScopeClearService } from "../src/clear-ddt-scope";
const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
const cutoff = "2026-10-31T00:00:00.000Z";
const input = { clearedBefore: cutoff, confirmation: "清空DDT用例" };
function fixture() {
  const cases = {
    readScopeClearCounts: vi
      .fn()
      .mockResolvedValue({ activeCases: 5, recycledCases: 2, suiteMembers: 3, affectedSuites: 1 }),
    clearScopePage: vi.fn().mockResolvedValue({
      phase: "done",
      removedMembers: 0,
      deletedHistory: 0,
      deletedCases: 0,
      deletedRecycled: 0,
      hasMore: false,
    }),
  };
  const suites = { unlinkDdtScopePage: vi.fn().mockResolvedValue(3) };
  const service = new DdtScopeClearService(
    cases,
    suites,
    { now: () => new Date(cutoff) },
    { next: () => "generated" },
  );
  return { cases, suites, service };
}
it("finishes one task version before deleting definitions and resumes after an interrupted page", async () => {
  const f = fixture();
  expect(
    await f.service.clearPage(scope, input, { principalId: "actor" }, "request"),
  ).toMatchObject({ phase: "tasks", removedMembers: 3, hasMore: true });
  expect(f.cases.clearScopePage).not.toHaveBeenCalled();
  f.suites.unlinkDdtScopePage.mockResolvedValue(0);
  expect(
    await f.service.clearPage(scope, input, { principalId: "actor" }, "request"),
  ).toMatchObject({ phase: "done", hasMore: false });
  expect(f.cases.clearScopePage).toHaveBeenCalledWith(
    expect.objectContaining({
      scope,
      clearedBefore: cutoff,
      auditActorId: "actor",
      requestId: "request",
    }),
  );
});
it("rejects a missing confirmation or future cutoff before any write", async () => {
  const f = fixture();
  for (const invalid of [
    { clearedBefore: cutoff },
    { ...input, clearedBefore: "2099-01-01T00:00:00.000Z" },
  ])
    await expect(
      f.service.clearPage(scope, invalid, { principalId: "actor" }, "request"),
    ).rejects.toThrow();
  expect(f.suites.unlinkDdtScopePage).not.toHaveBeenCalled();
  expect(f.cases.clearScopePage).not.toHaveBeenCalled();
});
it("takes the preview cutoff from the application clock", async () => {
  const f = fixture();
  expect(await f.service.preview(scope)).toMatchObject({ clearedBefore: cutoff, activeCases: 5 });
  expect(f.cases.readScopeClearCounts).toHaveBeenCalledWith(scope, cutoff);
});
