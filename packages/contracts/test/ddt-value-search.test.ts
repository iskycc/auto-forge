import { describe, expect, it } from "vitest";
import { ddtValueSearchInputSchema, ddtValueSearchPageSchema } from "../src/ddt";

const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };

describe("DDT value search boundary", () => {
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
    ])
      expect(ddtValueSearchInputSchema.safeParse(invalid).success).toBe(false);
  });
  it("distinguishes an incomplete empty slice from an exhausted search", () => {
    expect(
      ddtValueSearchPageSchema.parse({ items: [], scannedCount: 256, nextCursor: "last" }),
    ).toHaveProperty("nextCursor", "last");
    expect(ddtValueSearchPageSchema.parse({ items: [], scannedCount: 0 })).not.toHaveProperty(
      "nextCursor",
    );
  });
});
