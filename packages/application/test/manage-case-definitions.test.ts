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

  it("authorizes and bounds complete execution-history pages", async () => {
    const getCaseDefinition = vi.fn().mockResolvedValue({ id: "case-1", projectId: "project-1" });
    const listCaseExecutionHistory = vi.fn().mockResolvedValue({ items: [] });
    const service = serviceWith({ getCaseDefinition, listCaseExecutionHistory });

    await expect(
      service.listExecutionHistory("case-1", ["project-1"], {
        cursor: "older-page",
        limit: 500,
        includeRunnerNames: true,
      }),
    ).resolves.toEqual({ items: [] });
    expect(getCaseDefinition).toHaveBeenCalledWith("case-1", ["project-1"]);
    expect(listCaseExecutionHistory).toHaveBeenCalledWith("case-1", {
      cursor: "older-page",
      limit: 100,
      includeRunnerNames: true,
    });
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

  it("inherits cases between version stages with new definition, version and method ids", async () => {
    const listCases = vi.fn().mockResolvedValue({
      items: [
        {
          id: "source-case",
          methods: [{ id: "source-method" }],
        },
      ],
    });
    const inheritCaseDefinitions = vi
      .fn()
      .mockResolvedValue({ inheritedCount: 1, skippedCount: 0 });
    const service = serviceWith({ listCases, inheritCaseDefinitions });

    await expect(
      service.inheritFromVersion({
        projectId: "project-1",
        sourceProjectVersionId: "version-1",
        sourceTestStageId: "stage-1",
        targetProjectVersionId: "version-2",
        targetTestStageId: "stage-2",
        actorId: "actor-1",
      }),
    ).resolves.toEqual({ inheritedCount: 1, skippedCount: 0 });
    expect(inheritCaseDefinitions).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProjectVersionId: "version-1",
        targetProjectVersionId: "version-2",
        records: [
          expect.objectContaining({
            sourceCaseDefinitionId: "source-case",
            methods: [expect.objectContaining({ sourceMethodId: "source-method" })],
          }),
        ],
      }),
    );
  });
  it("copies only one bounded page and passes the source revision and continuation cursor", async () => {
    const listCases = vi.fn().mockResolvedValue({
      items: [{ id: "source-case", revision: 7, methods: [{ id: "source-method" }] }],
      nextCursor: "next-page",
    });
    const inheritCaseDefinitions = vi
      .fn()
      .mockResolvedValue({ inheritedCount: 1, skippedCount: 0 });
    const input = {
      projectId: "project",
      sourceProjectVersionId: "source",
      sourceTestStageId: "source-stage",
      targetProjectVersionId: "target",
      targetTestStageId: "target-stage",
      actorId: "actor",
      cursor: "first-page",
    };
    const service = serviceWith({ listCases, inheritCaseDefinitions });
    await expect(service.inheritPage(input)).resolves.toEqual({
      inheritedCount: 1,
      skippedCount: 0,
      nextCursor: "next-page",
    });
    expect(listCases).toHaveBeenCalledExactlyOnceWith({
      projectIds: ["project"],
      projectVersionId: "source",
      testStageId: "source-stage",
      scopedOnly: true,
      limit: 25,
      cursor: "first-page",
    });
    expect(inheritCaseDefinitions.mock.calls[0]![0].records[0]).toMatchObject({
      sourceRevision: 7,
    });
    await expect(
      service.inheritPage({ ...input, sourceProjectVersionId: "target" }),
    ).rejects.toMatchObject({ code: "CASE_VERSION_INHERITANCE_SELF_REFERENCE" });
    expect(listCases).toHaveBeenCalledTimes(1);
  });

  it("finishes an empty inheritance page without a write", async () => {
    const inheritCaseDefinitions = vi.fn();
    const service = serviceWith({
      listCases: vi.fn().mockResolvedValue({ items: [] }),
      inheritCaseDefinitions,
    });
    await expect(
      service.inheritPage({
        projectId: "project",
        sourceProjectVersionId: "source",
        sourceTestStageId: "source-stage",
        targetProjectVersionId: "target",
        targetTestStageId: "target-stage",
        actorId: "actor",
      }),
    ).resolves.toEqual({ inheritedCount: 0, skippedCount: 0 });
    expect(inheritCaseDefinitions).not.toHaveBeenCalled();
  });
});
