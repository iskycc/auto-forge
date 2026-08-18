import { describe, expect, it } from "vitest";

import { CLASS_PREVIEW_LIMIT, uniqueInspectionClasses } from "./class-preview";

type PreviewClass = Parameters<typeof uniqueInspectionClasses>[0][number];

function candidate(className: string): PreviewClass {
  return {
    className,
    packageName: className.split(".").slice(0, -1).join("."),
    simpleName: className.split(".").at(-1) ?? className,
    enabled: true,
    classLevelTest: false,
    groups: [],
    methods: [],
  };
}

describe("uniqueInspectionClasses", () => {
  it("keeps the first candidate per className to avoid duplicate React keys", () => {
    const classes = [
      candidate("com.example.A"),
      candidate("com.example.B"),
      candidate("com.example.A"),
    ];
    expect(uniqueInspectionClasses(classes).map((item) => item.className)).toEqual([
      "com.example.A",
      "com.example.B",
    ]);
  });

  it("exposes a bounded preview limit for large imports", () => {
    expect(CLASS_PREVIEW_LIMIT).toBe(100);
  });
});
