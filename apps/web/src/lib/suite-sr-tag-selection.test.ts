import { describe, expect, it } from "vitest";
import { collectSuiteSrTagMembers } from "./suite-sr-tag-selection";
describe("task SR label selection", () => {
  it("collects identifiers across pages and preserves distinct cases with the same SR", async () => {
    const members = await collectSuiteSrTagMembers(
      async (cursor) =>
        cursor
          ? { items: [{ id: "two", srNum: "SR" }] }
          : { items: [{ id: "one", srNum: "SR" }], nextCursor: "next" },
      new AbortController().signal,
      () => undefined,
    );
    expect(members.map((item) => item.id)).toEqual(["one", "two"]);
  });
  it("rejects repeated cursors rather than returning an incomplete selection", async () => {
    await expect(
      collectSuiteSrTagMembers(
        async () => ({ items: [], nextCursor: "same" }),
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow("分页未能继续");
  });
  it("does not return partial results after cancellation or a failed page", async () => {
    const controller = new AbortController();
    await expect(
      collectSuiteSrTagMembers(
        async () => {
          controller.abort();
          return { items: [{ id: "one", srNum: "SR" }] };
        },
        controller.signal,
        () => undefined,
      ),
    ).rejects.toThrow();
    await expect(
      collectSuiteSrTagMembers(
        async (cursor) => {
          if (cursor) throw new Error("failed");
          return { items: [{ id: "one", srNum: "SR" }], nextCursor: "next" };
        },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow("failed");
  });
});
