import { describe, expect, it, vi } from "vitest";
import { defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";
import { CaseSuiteService } from "../src/manage-case-suites";
import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  DdtRepository,
  ProjectStructureRepository,
} from "../src/ports";

function fixture() {
  const suites = {
    getSummary: vi.fn().mockResolvedValue({
      id: "suite",
      projectId: "project",
      policy: { ...defaultCaseSuiteExecutionPolicy, projectVersionId: "version" },
    }),
    get: vi.fn(),
    findMemberDdtCaseIds: vi.fn().mockResolvedValue(["member"]),
    removeDdtCases: vi.fn(),
  };
  const ddt = {
    listCases: vi.fn().mockResolvedValue({
      items: [
        { id: "member", caseId: "中文-001" },
        { id: "not-member", caseId: "OTHER" },
      ],
    }),
    getCases: vi.fn(),
  };
  const service = new CaseSuiteService(
    suites as unknown as CaseSuiteRepository,
    {} as CaseCatalogRepository,
    {} as ProjectStructureRepository,
    { now: () => new Date("2026-10-25T00:00:00Z") },
    { next: () => "unused" },
    undefined,
    ddt as unknown as DdtRepository,
  );
  const input = {
    projectVersionId: "version",
    testStageId: "stage",
    caseIds: [" 中文-001 ", "中文-001", "other", "missing"],
  };
  return { service, suites, ddt, input };
}

describe("task DDT selection matching", () => {
  it("matches only task members with bounded metadata and preserves unmatched identifiers", async () => {
    const { service, suites, ddt, input } = fixture();
    expect(await service.matchDdtCases("suite", input, ["project"])).toEqual({
      items: [{ id: "member", caseId: "中文-001" }],
      unmatchedCaseIds: ["other", "missing"],
    });
    expect(suites.getSummary).toHaveBeenCalledWith("suite", ["project"]);
    expect(ddt.listCases).toHaveBeenCalledWith({
      projectId: "project",
      projectVersionId: "version",
      testStageId: "stage",
      caseIds: ["中文-001", "other", "missing"],
      limit: 200,
      filters: [],
    });
    expect(suites.findMemberDdtCaseIds).toHaveBeenCalledWith("suite", ["member", "not-member"]);
    expect(suites.get).not.toHaveBeenCalled();
    expect(ddt.getCases).not.toHaveBeenCalled();
    expect(suites.removeDdtCases).not.toHaveBeenCalled();
  });
  it("rejects foreign versions or inaccessible tasks before reading case metadata", async () => {
    const { service, suites, ddt, input } = fixture();
    await expect(
      service.matchDdtCases("suite", { ...input, projectVersionId: "foreign" }),
    ).rejects.toMatchObject({ code: "DDT_CASE_VERSION_MISMATCH" });
    suites.getSummary.mockResolvedValue(null);
    await expect(service.matchDdtCases("suite", input, ["foreign"])).rejects.toMatchObject({
      code: "CASE_SUITE_NOT_FOUND",
    });
    expect(ddt.listCases).not.toHaveBeenCalled();
  });
  it("rejects oversized reads and treats absent task members as skipped", async () => {
    const { service, ddt, input } = fixture();
    await expect(
      service.matchDdtCases("suite", {
        ...input,
        caseIds: Array.from({ length: 201 }, (_, i) => `id-${i}`),
      }),
    ).rejects.toMatchObject({ code: "CASE_SUITE_SELECTION_INVALID" });
    ddt.listCases.mockResolvedValue({ items: [] });
    expect(await service.matchDdtCases("suite", { ...input, caseIds: ["missing"] })).toEqual({
      items: [],
      unmatchedCaseIds: ["missing"],
    });
  });
});
