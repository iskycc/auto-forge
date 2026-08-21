import { describe, expect, it, vi } from "vitest";

import type { CaseCatalogRepository } from "../src/ports";
import { CaseDefinitionService } from "../src/manage-case-definitions";

function serviceWith(catalog: Partial<CaseCatalogRepository>) {
  return new CaseDefinitionService(
    catalog as CaseCatalogRepository,
    { now: () => new Date("2026-08-09T00:00:00.000Z") },
    { next: vi.fn().mockReturnValue("generated-id") },
  );
}

describe("CaseDefinitionService", () => {
  it("rejects restoring a version whose snapshot no longer parses", async () => {
    const service = serviceWith({
      getCaseDefinition: vi.fn().mockResolvedValue({
        id: "case-1",
        revision: 3,
        currentVersion: 2,
      }),
      getCaseVersion: vi.fn().mockResolvedValue({
        id: "version-1",
        caseDefinitionId: "case-1",
        sourceId: "source-1",
        version: 1,
        snapshot: { className: 42 },
        changeReason: "source.import",
        createdAt: "2026-08-09T00:00:00.000Z",
      }),
      restoreCaseVersion: vi.fn(),
    });

    await expect(service.restoreVersion("case-1", 1, "actor-1")).rejects.toMatchObject({
      code: "CASE_VERSION_SNAPSHOT_INVALID",
    });
  });

  it("rejects metadata updates when the stored revision moved on", async () => {
    const service = serviceWith({
      getCaseDefinition: vi.fn().mockResolvedValue({ id: "case-1", revision: 5 }),
      updateCaseDefinition: vi.fn(),
    });

    await expect(
      service.update("case-1", { displayName: "新名称", expectedRevision: 4 }, "actor-1"),
    ).rejects.toMatchObject({ code: "CASE_DEFINITION_REVISION_CONFLICT" });
  });

  it("deletes a deduplicated selection only inside the authorized project scope", async () => {
    const deleteCaseDefinitions = vi.fn().mockResolvedValue([
      { id: "case-1", projectId: "project-a", displayName: "Case One" },
      { id: "case-2", projectId: "project-a", displayName: "Case Two" },
    ]);
    const service = serviceWith({ deleteCaseDefinitions });

    await expect(
      service.deleteMany(["case-1", "case-1", "case-2"], ["project-a"]),
    ).resolves.toHaveLength(2);
    expect(deleteCaseDefinitions).toHaveBeenCalledWith(["case-1", "case-2"], ["project-a"]);
    await expect(service.deleteMany([])).rejects.toMatchObject({
      code: "CASE_DEFINITION_IDS_REQUIRED",
    });
  });
});
