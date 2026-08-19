import { describe, expect, it } from "vitest";

import { columnCharacterWidthAtCoverage, widestText } from "./table-column-width";

describe("columnCharacterWidthAtCoverage", () => {
  it("uses the 70 percent coverage width instead of the longest outlier", () => {
    const values = ["short", "normal-1", "normal-22", "正常中文", "x".repeat(200)];

    expect(columnCharacterWidthAtCoverage(values, { minimum: 4, maximum: 80 })).toBe(9);
  });

  it("honours explicit lower and upper bounds", () => {
    expect(columnCharacterWidthAtCoverage(["x"], { minimum: 8, maximum: 20 })).toBe(8);
    expect(columnCharacterWidthAtCoverage(["x".repeat(100)], { minimum: 8, maximum: 20 })).toBe(20);
  });

  it("selects the visually widest line for each row", () => {
    expect(widestText(["123456", "中文字段"])).toBe("中文字段");
  });
});
