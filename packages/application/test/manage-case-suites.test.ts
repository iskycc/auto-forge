import { describe, expect, it, vi } from "vitest";

import { DomainError, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";

import { CaseSuiteService } from "../src/manage-case-suites";
import type { CaseCatalogRepository, CaseSuiteRepository } from "../src/ports";

const timestamp = "2026-08-09T00:00:00.000Z";

describe("case suite update and copy", () => {
  it("binds a new suite to its selected project version", async () => {
    const suites = suiteRepositoryFake();
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      { now: () => new Date(timestamp) },
      { next: () => "suite-new" },
    );

    await service.create(
      {
        projectId: "project-1",
        projectVersionId: "version-2",
        name: "Version smoke",
      },
      "user-1",
    );

    expect(suites.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "suite-new",
        projectId: "project-1",
        actorId: "user-1",
        policy: expect.objectContaining({ projectVersionId: "version-2" }),
      }),
    );
  });

  it("merges partial policy input over the stored policy before persisting", async () => {
    const suites = suiteRepositoryFake();
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
    );

    await service.update("suite-1", {
      policy: { concurrency: 8 },
      enabled: false,
      expectedRevision: 2,
    });

    expect(suites.updateSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: "suite-1",
        expectedRevision: 2,
        enabled: false,
        changeReason: "suite.update:policy+disable",
        policy: {
          ...defaultCaseSuiteExecutionPolicy,
          runnerIds: ["runner-1"],
          runnerLabels: ["gpu"],
          concurrency: 8,
        },
      }),
    );
  });

  it("rejects stale revisions before touching the repository", async () => {
    const suites = suiteRepositoryFake();
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
    );

    await expect(service.update("suite-1", { name: "new", expectedRevision: 1 })).rejects.toThrow(
      DomainError,
    );
    await expect(
      service.update("suite-1", { name: "new", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "CASE_SUITE_REVISION_CONFLICT" });
    expect(suites.updateSuite).not.toHaveBeenCalled();
  });

  it("copies the source suite with fresh ids and the inherited policy", async () => {
    const suites = suiteRepositoryFake();
    let generated = 0;
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      { now: () => new Date(timestamp) },
      { next: () => `id-${++generated}` },
    );

    await service.copy("suite-1", { name: "Smoke 副本" }, "user-1");

    expect(suites.copySuite).toHaveBeenCalledWith({
      id: "id-1",
      projectId: "project-1",
      name: "Smoke 副本",
      description: "smoke suite",
      policy: {
        ...defaultCaseSuiteExecutionPolicy,
        runnerIds: ["runner-1"],
        runnerLabels: ["gpu"],
      },
      items: [{ id: "id-2", caseDefinitionId: "case-1" }],
      versionId: "id-3",
      actorId: "user-1",
      createdAt: timestamp,
    });
  });

  it("removes a unique case selection in one repository operation", async () => {
    const suites = suiteRepositoryFake();
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      { now: () => new Date(timestamp) },
      { next: () => "version-3" },
    );

    await service.removeCases("suite-1", ["case-1", "case-1", "case-2"], "user-1");

    expect(suites.removeCases).toHaveBeenCalledOnce();
    expect(suites.removeCases).toHaveBeenCalledWith({
      suiteId: "suite-1",
      caseDefinitionIds: ["case-1", "case-2"],
      versionId: "version-3",
      actorId: "user-1",
      updatedAt: timestamp,
    });
  });

  it("does not impose the retired 500-case task capacity", async () => {
    const suites = suiteRepositoryFake();
    const existingItems = Array.from({ length: 500 }, (_, index) => ({
      id: `item-${index}`,
      suiteId: "suite-1",
      addedAt: timestamp,
      caseDefinition: { id: `case-${index}` },
    }));
    suites.getSummary.mockResolvedValueOnce({
      ...(await suites.getSummary("suite-1")),
      caseCount: existingItems.length,
    });
    const catalog = {
      findExistingCaseIds: vi.fn().mockResolvedValue(["case-500"]),
    } as unknown as CaseCatalogRepository;
    const service = new CaseSuiteService(
      suites,
      catalog,
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
    );

    await service.addCases("suite-1", ["case-500"], "user-1");

    expect(suites.addCases).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: "suite-1",
        items: [{ id: "generated-id", caseDefinitionId: "case-500" }],
      }),
    );
  });
});

function suiteRepositoryFake() {
  const suite = {
    id: "suite-1",
    projectId: "project-1",
    name: "Smoke",
    description: "smoke suite",
    version: 2,
    revision: 2,
    status: "active",
    enabled: true,
    policy: {
      ...defaultCaseSuiteExecutionPolicy,
      runnerIds: ["runner-1"],
      runnerLabels: ["gpu"],
    },
    caseCount: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    items: [
      {
        id: "item-1",
        suiteId: "suite-1",
        addedAt: timestamp,
        caseDefinition: { id: "case-1" },
      },
    ],
  };
  return {
    create: vi.fn().mockResolvedValue(suite),
    get: vi.fn().mockResolvedValue(suite),
    getSummary: vi.fn().mockResolvedValue(suite),
    updateSuite: vi.fn().mockResolvedValue(suite),
    copySuite: vi.fn().mockResolvedValue(suite),
    addCases: vi.fn().mockResolvedValue(suite),
    removeCases: vi.fn().mockResolvedValue(suite),
  } as unknown as CaseSuiteRepository & {
    create: ReturnType<typeof vi.fn>;
    getSummary: ReturnType<typeof vi.fn>;
    updateSuite: ReturnType<typeof vi.fn>;
    copySuite: ReturnType<typeof vi.fn>;
    addCases: ReturnType<typeof vi.fn>;
    removeCases: ReturnType<typeof vi.fn>;
  };
}
