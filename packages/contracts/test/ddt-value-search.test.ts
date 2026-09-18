import { describe, expect, it } from "vitest";
import { ddtValueSearchInputSchema, ddtValueSearchPageSchema } from "../src/ddt";

const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };

describe("DDT value search boundary", () => {
  it("accepts multiple literal keywords and bounds their combined query size", () => {
    expect(
      ddtValueSearchInputSchema.parse({ ...scope, keywords: [" 钱包 ", "PAYMENT", "钱包"] }),
    ).toMatchObject({
      keywords: ["钱包", "PAYMENT"],
      limit: 20,
    });
    for (const query of [
      {},
      { keywords: [] },
      { keywords: ["钱包", " "] },
      { keywords: Array.from({ length: 13 }, (_, index) => String(index)) },
      { keywords: ["a".repeat(300), "b".repeat(300)] },
      { keyword: "钱包", keywords: ["支付"] },
    ])
      expect(ddtValueSearchInputSchema.safeParse({ ...scope, ...query }).success).toBe(false);
    expect(
      ddtValueSearchInputSchema.parse({ ...scope, keywords: ["Payment", "payment", "a,b"] }),
    ).toHaveProperty("keywords", ["Payment", "a,b"]);
  });
  it("requires a scoped nonempty keyword and a bounded result window", () => {
    expect(ddtValueSearchInputSchema.parse({ ...scope, keyword: " 钱包 " })).toEqual({
      ...scope,
      keyword: "钱包",
      limit: 20,
    });
    for (const invalid of [
      { ...scope, keyword: " " },
      { keyword: "match" },
      { ...scope, keyword: "a".repeat(513) },
      { ...scope, keyword: "match", limit: 21 },
      { ...scope, keyword: "match", cursor: "a".repeat(1025) },
      { ...scope, keyword: "match", indexOffset: -1 },
      { ...scope, keyword: "match", indexOffset: 20 },
      { ...scope, keyword: "match", indexOffset: 1.5 },
    ])
      expect(ddtValueSearchInputSchema.safeParse(invalid).success).toBe(false);
  });
  it("accepts bounded page index summaries without returning every matching case", () => {
    const page = {
      items: [],
      scannedCount: 256,
      nextCursor: "last",
      index: { matchedCount: 23, pageCursors: ["", "case-20"] },
    };
    expect(ddtValueSearchPageSchema.parse(page)).toEqual(page);
    expect(
      ddtValueSearchInputSchema.parse({ ...scope, keyword: "match", indexOffset: 0 }),
    ).toHaveProperty("indexOffset", 0);
  });
  it("distinguishes an incomplete empty slice from an exhausted search", () => {
    expect(
      ddtValueSearchPageSchema.parse({ items: [], scannedCount: 256, nextCursor: "last" }),
    ).toHaveProperty("nextCursor", "last");
    expect(ddtValueSearchPageSchema.parse({ items: [], scannedCount: 0 })).not.toHaveProperty(
      "nextCursor",
    );
  });
  it("preserves CaseName while accepting older results without it", () => {
    const item = {
      id: "id",
      caseId: "CASE-1",
      srNum: "SR",
      matchCount: 1,
      matches: [{ path: ["description"], value: "match" }],
    };
    const page = { items: [{ ...item, caseName: "余额查询" }, item], scannedCount: 2 };
    expect(ddtValueSearchPageSchema.parse(page)).toEqual(page);
  });
});
