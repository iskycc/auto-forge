import { describe, expect, it, vi } from "vitest";

import { listCompleteCaseDirectory } from "./case-directory";

describe("listCompleteCaseDirectory", () => {
  it("reads every cursor page instead of stopping at the former 50-case boundary", async () => {
    const firstItems = Array.from({ length: 500 }, (_, index) => caseItem(`first-${index}`));
    const secondItems = Array.from({ length: 73 }, (_, index) => caseItem(`second-${index}`));
    const listCases = vi
      .fn()
      .mockResolvedValueOnce({ items: firstItems, nextCursor: "next-page" })
      .mockResolvedValueOnce({ items: secondItems });

    const result = await listCompleteCaseDirectory({ listCases }, { scopedOnly: true });

    expect(result).toHaveLength(573);
    expect(listCases).toHaveBeenNthCalledWith(1, { scopedOnly: true, limit: 500 });
    expect(listCases).toHaveBeenNthCalledWith(2, {
      scopedOnly: true,
      cursor: "next-page",
      limit: 500,
    });
  });

  it("rejects a repository that repeats its cursor", async () => {
    const listCases = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: "repeated" })
      .mockResolvedValueOnce({ items: [], nextCursor: "repeated" });

    await expect(listCompleteCaseDirectory({ listCases }, {})).rejects.toThrow(
      "repeated cursor repeated",
    );
  });
});

function caseItem(id: string) {
  return {
    id,
    projectId: "project",
    projectVersionId: "version",
    testStageId: "stage",
    directoryPath: "fixtures",
    sourceId: "source",
    className: `fixtures.${id}`,
    packageName: "fixtures",
    displayName: id,
    description: "",
    tags: [],
    enabled: true,
    archived: false,
    groups: [],
    parameters: {},
    currentVersion: 1,
    revision: 1,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    methods: [],
  };
}
