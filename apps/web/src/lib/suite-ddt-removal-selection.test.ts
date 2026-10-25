import { describe, expect, it, vi } from "vitest";
import { collectSuiteDdtRemovalSelection } from "./suite-ddt-removal-selection";

describe("task removal preview", () => {
  it("matches beyond unloaded pages in sequential bounded requests and reports skipped cases", async () => {
    const caseIds = Array.from({ length: 405 }, (_, i) => `CASE-${i}`);
    const read = vi.fn(async (ids: string[]) => ({
      items: ids
        .filter((id) => id.endsWith("0"))
        .map((caseId) => ({ id: `row-${caseId}`, caseId })),
      unmatchedCaseIds: ids.filter((id) => !id.endsWith("0")),
    }));
    const progress = vi.fn();
    const result = await collectSuiteDdtRemovalSelection(
      caseIds,
      read,
      new AbortController().signal,
      progress,
    );
    expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([200, 200, 5]);
    expect(result.items).toHaveLength(41);
    expect(result.unmatchedCaseIds).toHaveLength(364);
    expect(progress).toHaveBeenLastCalledWith(405, 405);
  });
  it("does not expose partial results after cancellation or a failed matching page", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => String(i));
    const controller = new AbortController();
    const read = vi.fn(async () => {
      controller.abort();
      return { items: [], unmatchedCaseIds: [] };
    });
    await expect(
      collectSuiteDdtRemovalSelection(ids, read, controller.signal, () => undefined),
    ).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce();
    let page = 0;
    await expect(
      collectSuiteDdtRemovalSelection(
        ids,
        async () => {
          if (++page === 2) throw new Error("matching failed");
          return { items: [{ id: "first", caseId: "0" }], unmatchedCaseIds: [] };
        },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow("matching failed");
  });
});
