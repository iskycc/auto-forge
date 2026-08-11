import { describe, expect, it, vi } from "vitest";

import { DomainError, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";

import { CaseSuiteService } from "../src/manage-case-suites";
import type { CaseCatalogRepository, CaseSuiteRepository } from "../src/ports";

const timestamp = "2026-08-09T00:00:00.000Z";

describe("case suite update and copy", () => {
  it("merges partial policy input over the stored policy before persisting", async () => {
    const suites = suiteRepositoryFake();
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
    );

    await service.update("suite-1", {
      policy: { concurrency: 8, parameters: { SUITE: "smoke" } },
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
          runnerLabels: ["gpu"],
          concurrency: 8,
          parameters: { SUITE: "smoke" },
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
      policy: { ...defaultCaseSuiteExecutionPolicy, runnerLabels: ["gpu"] },
      items: [{ id: "id-2", caseDefinitionId: "case-1" }],
      versionId: "id-3",
      actorId: "user-1",
      createdAt: timestamp,
    });
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
    policy: { ...defaultCaseSuiteExecutionPolicy, runnerLabels: ["gpu"] },
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
    get: vi.fn().mockResolvedValue(suite),
    updateSuite: vi.fn().mockResolvedValue(suite),
    copySuite: vi.fn().mockResolvedValue(suite),
  } as unknown as CaseSuiteRepository & {
    updateSuite: ReturnType<typeof vi.fn>;
    copySuite: ReturnType<typeof vi.fn>;
  };
}
