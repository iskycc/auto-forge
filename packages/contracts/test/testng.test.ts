import { describe, expect, it } from "vitest";

import { testNgXmlSelectionSchema } from "../src/testng";

describe("TestNG discovery contracts", () => {
  it("does not cap testng.xml class selections at 5000 entries", () => {
    const selectedClasses = Array.from({ length: 5_001 }, (_, index) => ({
      className: `com.example.GeneratedTest${index}`,
      includedMethods: [],
      excludedMethods: [],
    }));

    const selection = testNgXmlSelectionSchema.parse({
      suiteName: "large-suite",
      testName: "large-test",
      parameters: {},
      includedGroups: [],
      excludedGroups: [],
      includedPackages: [],
      selectedClasses,
    });

    expect(selection.selectedClasses).toHaveLength(selectedClasses.length);
  });
});
