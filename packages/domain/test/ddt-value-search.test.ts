import { describe, expect, it } from "vitest";
import { findDdtValueMatches } from "../src/ddt-value-search";

describe("DDT value-only search", () => {
  it("excludes keys and containers while returning literal paths for nested values", () => {
    const data = {
      KEY_ONLY: "different",
      "quoted.key[0]": "中文 Payment",
      用户旅程: { step1: { KEY_ONLY: "payment approved" } },
    };
    expect(findDdtValueMatches(data, "KEY_ONLY").matches).toEqual([]);
    expect(findDdtValueMatches(data, "step1").matches).toEqual([]);
    expect(findDdtValueMatches(data, "payment")).toEqual({
      matchCount: 2,
      matches: [
        { path: ["quoted.key[0]"], value: "中文 Payment" },
        { path: ["用户旅程", "step1", "KEY_ONLY"], value: "payment approved" },
      ],
    });
  });
  it("matches scalar numbers, booleans, null and literal wildcard characters", () => {
    const data = { amount: 123.5, enabled: false, blank: null, text: "50%_\\price" };
    for (const keyword of ["123.5", "FALSE", "null", "%_\\"]) {
      expect(findDdtValueMatches(data, keyword).matchCount).toBe(1);
    }
    expect(findDdtValueMatches(data, " ").matchCount).toBe(0);
    expect(findDdtValueMatches(data, "missing").matchCount).toBe(0);
  });
  it("bounds previews without overlooking matches late in long values or many fields", () => {
    const data = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `field-${index}`,
        "x".repeat(10000) + "NEEDLE" + "y".repeat(10000),
      ]),
    );
    const result = findDdtValueMatches(data, "needle");
    expect(result.matchCount).toBe(12);
    expect(result.matches).toHaveLength(8);
    expect(result.matches[0]!.value).toContain("NEEDLE");
    expect(result.matches[0]!.value.length).toBeLessThan(300);
  });
});
