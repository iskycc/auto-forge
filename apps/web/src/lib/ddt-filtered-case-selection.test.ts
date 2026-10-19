import { expect, it } from "vitest";
import { collectFilteredDdtCaseIds, ddtCaseFilterParameters } from "./ddt-filtered-case-selection";

it("keeps category unions and existing filters on every page", () => {
  const query = ddtCaseFilterParameters(
    {
      query: " Wallet ",
      srNum: "SR",
      categoryIds: ["a", "b"],
      advancedField: " owner ",
      advancedOperator: "eq",
      advancedValue: "qa",
    },
    200,
    "next",
  );
  expect(query.getAll("categoryId")).toEqual(["a", "b"]);
  expect(query.get("query")).toBe("Wallet");
  expect(query.get("cursor")).toBe("next");
  expect(JSON.parse(query.get("filters")!)).toEqual([
    { field: "owner", operator: "eq", value: "qa" },
  ]);
});
it("collects beyond the loaded page without duplicates or rendering more rows", async () => {
  const seen: Array<string | undefined> = [];
  const result = await collectFilteredDdtCaseIds(
    async (cursor) => {
      seen.push(cursor);
      return cursor
        ? { items: [{ caseId: "a" }, { caseId: "B" }] }
        : { items: [{ caseId: "A" }], nextCursor: "next" };
    },
    new AbortController().signal,
    () => undefined,
  );
  expect(seen).toEqual([undefined, "next"]);
  expect(result).toEqual(["a", "B"]);
});
it("rejects a repeated cursor and cancels without returning a partial selection", async () => {
  await expect(
    collectFilteredDdtCaseIds(
      async () => ({ items: [], nextCursor: "repeat" }),
      new AbortController().signal,
      () => undefined,
    ),
  ).rejects.toThrow("分页未能继续");
  const controller = new AbortController();
  await expect(
    collectFilteredDdtCaseIds(
      async () => {
        controller.abort();
        return { items: [{ caseId: "A" }] };
      },
      controller.signal,
      () => undefined,
    ),
  ).rejects.toThrow();
});

it("selects 100,000 task members in bounded pages and rejects a larger partial result", async () => {
  const read = (total: number) => async (cursor?: string) => {
    const offset = Number(cursor ?? 0);
    const end = Math.min(offset + 200, total);
    return {
      items: Array.from({ length: end - offset }, (_, index) => ({
        caseId: `CASE-${offset + index}`,
      })),
      ...(end < total ? { nextCursor: String(end) } : {}),
    };
  };
  expect(
    await collectFilteredDdtCaseIds(read(100_000), new AbortController().signal, () => undefined),
  ).toHaveLength(100_000);
  await expect(
    collectFilteredDdtCaseIds(read(100_001), new AbortController().signal, () => undefined),
  ).rejects.toThrow("100,000");
});
