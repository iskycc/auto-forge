import { describe, expect, it } from "vitest";

import {
  collectSelectableDirectoryCaseIds,
  selectionState,
  toggledSelection,
  type SelectableDirectory,
} from "./case-directory-selection";

const tree: SelectableDirectory = {
  directories: [
    {
      directories: [],
      cases: [
        { id: "case-a", projectId: "project-a" },
        { id: "case-b", projectId: "project-a" },
      ],
    },
  ],
  cases: [{ id: "case-c", projectId: "project-b" }],
};

describe("case directory folder selection", () => {
  it("collects every manageable descendant instead of only direct children", () => {
    expect(
      collectSelectableDirectoryCaseIds(tree, (projectId) => projectId === "project-a"),
    ).toEqual(["case-a", "case-b"]);
  });

  it("selects and clears the whole folder while preserving unrelated cases", () => {
    const selected = toggledSelection(new Set(["unrelated"]), ["case-a", "case-b"]);
    expect([...selected].sort()).toEqual(["case-a", "case-b", "unrelated"]);
    expect(selectionState(selected, ["case-a", "case-b"])).toBe("checked");

    const cleared = toggledSelection(selected, ["case-a", "case-b"]);
    expect([...cleared]).toEqual(["unrelated"]);
  });

  it("reports a partially selected folder as mixed", () => {
    expect(selectionState(new Set(["case-a"]), ["case-a", "case-b"])).toBe("mixed");
  });

  it("selects every descendant in a 100,000-case folder", () => {
    const largeDirectory: SelectableDirectory = {
      directories: [],
      cases: Array.from({ length: 100_000 }, (_, index) => ({
        id: `case-${index}`,
        projectId: "project-a",
      })),
    };
    const ids = collectSelectableDirectoryCaseIds(largeDirectory, () => true);
    const selected = toggledSelection(new Set(), ids);

    expect(ids).toHaveLength(100_000);
    expect(selected.size).toBe(100_000);
    expect(selectionState(selected, ids)).toBe("checked");
  });
});
