import { describe, expect, it, vi } from "vitest";

import { DomainError, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";

import { CaseSuiteService } from "../src/manage-case-suites";
import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  ProjectStructureRepository,
  SecretCipherPort,
} from "../src/ports";

const timestamp = "2026-08-09T00:00:00.000Z";

describe("case suite update and copy", () => {
  it("binds a new suite to its selected project version", async () => {
    const suites = suiteRepositoryFake();
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      projectStructuresFake(["version-1", "version-2"]),
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
      projectStructuresFake(),
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
          projectVersionId: "version-1",
          runnerIds: ["runner-1"],
          runnerLabels: ["gpu"],
          concurrency: 8,
        },
      }),
    );
  });

  it("encrypts Jenkins credentials outside the public task policy", async () => {
    const suites = suiteRepositoryFake();
    const cipher = {
      available: true,
      encrypt: vi.fn().mockReturnValue("encrypted-api-key"),
      decrypt: vi.fn(),
    } as SecretCipherPort;
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      projectStructuresFake(),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      cipher,
    );

    await service.update("suite-1", {
      policy: {
        retryMode: "round",
        retryLimit: 2,
        roundRecoveryRules: [
          {
            id: "recovery-1",
            afterRound: 1,
            jenkinsJobUrl: "https://jenkins.internal/job/reset",
            waitMinutes: 5,
            apiKey: "jenkins-user:api-token",
          },
        ],
      },
      expectedRevision: 2,
    });

    expect(cipher.encrypt).toHaveBeenCalledWith(
      "jenkins-user:api-token",
      "case-suite-round-recovery:suite-1:recovery-1",
    );
    expect(suites.updateSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({
          roundRecoveryRules: [
            expect.objectContaining({
              id: "recovery-1",
              apiKeyConfigured: true,
              jenkinsJobUrl: "https://jenkins.internal/job/reset/",
            }),
          ],
        }),
        roundRecoveryCredentialUpserts: { "recovery-1": "encrypted-api-key" },
      }),
    );
    expect(JSON.stringify(suites.updateSuite.mock.calls)).not.toContain("api-token");
  });

  it("rejects stale revisions before touching the repository", async () => {
    const suites = suiteRepositoryFake();
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      projectStructuresFake(),
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
      projectStructuresFake(),
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
        projectVersionId: "version-1",
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
      projectStructuresFake(),
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
      projectStructuresFake(),
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
    expect(catalog.findExistingCaseIds).toHaveBeenCalledWith(
      ["case-500"],
      "project-1",
      "version-1",
    );
  });

  it("rejects an omitted version when a project has multiple active versions", async () => {
    const suites = suiteRepositoryFake();
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      projectStructuresFake(["version-1", "version-2"]),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
    );

    await expect(
      service.create({ projectId: "project-1", name: "Ambiguous" }),
    ).rejects.toMatchObject({ code: "CASE_SUITE_VERSION_REQUIRED" });
    expect(suites.create).not.toHaveBeenCalled();
  });

  it("rejects adding cases from another project version", async () => {
    const suites = suiteRepositoryFake();
    const catalog = {
      findExistingCaseIds: vi.fn().mockResolvedValue([]),
    } as unknown as CaseCatalogRepository;
    const service = new CaseSuiteService(
      suites,
      catalog,
      projectStructuresFake(),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
    );

    await expect(service.addCases("suite-1", ["case-from-version-2"])).rejects.toMatchObject({
      code: "CASE_DEFINITION_VERSION_MISMATCH",
    });
    expect(catalog.findExistingCaseIds).toHaveBeenCalledWith(
      ["case-from-version-2"],
      "project-1",
      "version-1",
    );
    expect(suites.addCases).not.toHaveBeenCalled();
  });

  it("rejects moving a suite while it contains cases from the original version", async () => {
    const suites = suiteRepositoryFake();
    const service = new CaseSuiteService(
      suites,
      {} as CaseCatalogRepository,
      projectStructuresFake(["version-1", "version-2"]),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
    );

    await expect(
      service.update("suite-1", {
        policy: { projectVersionId: "version-2" },
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "CASE_SUITE_VERSION_MISMATCH" });
    expect(suites.updateSuite).not.toHaveBeenCalled();
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
      projectVersionId: "version-1",
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
        caseDefinition: { id: "case-1", projectVersionId: "version-1" },
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
    getRoundRecoveryCredentials: vi.fn().mockResolvedValue({}),
  } as unknown as CaseSuiteRepository & {
    create: ReturnType<typeof vi.fn>;
    getSummary: ReturnType<typeof vi.fn>;
    updateSuite: ReturnType<typeof vi.fn>;
    copySuite: ReturnType<typeof vi.fn>;
    addCases: ReturnType<typeof vi.fn>;
    removeCases: ReturnType<typeof vi.fn>;
  };
}

function projectStructuresFake(versionIds = ["version-1"]): ProjectStructureRepository {
  return {
    list: vi.fn().mockResolvedValue({
      versions: versionIds.map((id) => ({
        id,
        projectId: "project-1",
        name: id,
        status: "active" as const,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        stages: [],
        adapterConfiguration: {
          projectId: "project-1",
          projectVersionId: id,
          revision: 1,
          updatedAt: timestamp,
        },
      })),
      adapterConfiguration: {
        projectId: "project-1",
        revision: 1,
        updatedAt: timestamp,
      },
    }),
  } as unknown as ProjectStructureRepository;
}
