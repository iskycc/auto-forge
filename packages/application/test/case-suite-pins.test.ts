import { describe, expect, it, vi } from "vitest";
import { defaultCaseSuiteExecutionPolicy, type CaseSuite } from "@autoforge/domain";
import { CaseSuiteService } from "../src/manage-case-suites";
import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  ProjectStructureRepository,
} from "../src/ports";

const timestamp = "2026-10-06T00:00:00.000Z";
const suite = (id: string, name: string): CaseSuite => ({
  id,
  name,
  projectId: "project",
  version: 1,
  revision: 1,
  status: "active",
  enabled: true,
  policy: defaultCaseSuiteExecutionPolicy,
  caseCount: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
});

function fixture() {
  const repository = {
    list: vi
      .fn()
      .mockResolvedValue([suite("ten", "任务 10"), suite("two", "任务 2"), suite("new", "任务 1")]),
    listPinnedSuiteIds: vi.fn().mockResolvedValue(["ten", "two"]),
    getSummary: vi.fn().mockResolvedValue(suite("two", "任务 2")),
    setPinned: vi.fn().mockResolvedValue(undefined),
    updateSuite: vi.fn(),
    get: vi.fn(),
  };
  const service = new CaseSuiteService(
    repository as unknown as CaseSuiteRepository,
    {} as CaseCatalogRepository,
    {} as ProjectStructureRepository,
    { now: () => new Date(timestamp) },
    { next: () => "unused" },
  );
  return { service, repository };
}

describe("personal task pinning", () => {
  it("selects pinned tasks before limiting the page and naturally orders only the pinned group", async () => {
    const { service, repository } = fixture();
    expect(await service.listForUser("user-a", 200, ["project"], "version")).toEqual({
      items: [suite("two", "任务 2"), suite("ten", "任务 10"), suite("new", "任务 1")],
      pinnedSuiteIds: ["ten", "two"],
    });
    expect(repository.list).toHaveBeenCalledWith(200, ["project"], "version", undefined, "user-a");
    expect(repository.listPinnedSuiteIds).toHaveBeenCalledWith("user-a", ["ten", "two", "new"]);
  });

  it.each([true, false])(
    "stores the authenticated user's desired pinned state %s without revising execution settings",
    async (pinned) => {
      const { service, repository } = fixture();
      await expect(service.setPinned("two", { pinned }, "user-a", ["project"])).resolves.toEqual({
        suiteId: "two",
        pinned,
      });
      expect(repository.getSummary).toHaveBeenCalledWith("two", ["project"]);
      expect(repository.setPinned).toHaveBeenCalledWith({
        userId: "user-a",
        suiteId: "two",
        pinned,
        createdAt: timestamp,
      });
      expect(repository.get).not.toHaveBeenCalled();
      expect(repository.updateSuite).not.toHaveBeenCalled();
    },
  );

  it("rejects an inaccessible or missing task without persisting a preference", async () => {
    const { service, repository } = fixture();
    repository.getSummary.mockResolvedValue(null);
    await expect(service.setPinned("two", { pinned: true }, "user-a", [])).rejects.toMatchObject({
      code: "CASE_SUITE_NOT_FOUND",
    });
    expect(repository.setPinned).not.toHaveBeenCalled();
  });
});
