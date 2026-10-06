import { describe, expect, it, vi } from "vitest";
import { defaultCaseSuiteExecutionPolicy, type CaseSuite } from "@autoforge/domain";

import { CaseSuiteService } from "../src/manage-case-suites";
import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  FailureCaseSuiteSource,
  ProjectStructureRepository,
} from "../src/ports";

function fixture(sourceOverrides: Partial<FailureCaseSuiteSource> = {}) {
  const source: FailureCaseSuiteSource = {
    suiteId: "source-suite",
    projectId: "project-1",
    status: "succeeded",
    kind: "standard",
    description: "执行时的描述",
    policy: {
      ...defaultCaseSuiteExecutionPolicy,
      projectVersionId: "version-1",
      runnerGroupId: "group-1",
      concurrency: 17,
      retryMode: "round",
      retryLimit: 2,
      roundRecoveryRules: [
        {
          id: "recovery-1",
          afterRound: 1,
          jenkinsJobUrl: "https://jenkins.internal/job/reset/",
          waitMinutes: 5,
          apiKeyConfigured: true,
        },
      ],
    },
    roundRecoveryCredentials: { "recovery-1": "source-ciphertext" },
    ...sourceOverrides,
  };
  const repository = {
    getFailureCopySource: vi.fn().mockResolvedValue(source),
    listFinalFailureMemberPage: vi.fn().mockResolvedValue([
      { runId: "run-1", caseId: "case-1", caseType: "testng", available: true },
      { runId: "run-2", caseId: "ddt-1", caseType: "ddt", available: true },
    ]),
    copySuite: vi.fn().mockResolvedValue({ id: "created-suite" } as CaseSuite),
  };
  const structures = {
    list: vi.fn().mockResolvedValue({
      versions: [{ id: "version-1", projectId: "project-1", status: "active" }],
    }),
  };
  const cipher = {
    available: true,
    createdAt: "2026-10-06T00:00:00.000Z",
    decrypt: vi.fn().mockReturnValue("jenkins-user:token"),
    encrypt: vi.fn().mockReturnValue("target-ciphertext"),
  };
  let nextId = 0;
  const service = new CaseSuiteService(
    repository as unknown as CaseSuiteRepository,
    {} as CaseCatalogRepository,
    structures as unknown as ProjectStructureRepository,
    { now: () => new Date("2026-10-06T00:00:00.000Z") },
    { next: () => `new-${++nextId}` },
    cipher,
  );
  return { source, repository, structures, cipher, service };
}

describe("create a reusable task from final execution failures", () => {
  it("copies the execution configuration and mixed members, rebinding Jenkins credentials", async () => {
    const { service, repository, source, cipher } = fixture();
    await service.createFromFinalFailures("batch-1", { name: "  失败任务  " }, "actor-1", [
      "project-1",
    ]);
    expect(repository.getFailureCopySource).toHaveBeenCalledWith("batch-1", ["project-1"]);
    expect(repository.copySuite).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "new-1",
        failureBatchId: "batch-1",
        projectId: "project-1",
        name: "失败任务",
        description: source.description,
        actorId: "actor-1",
        policy: expect.objectContaining({
          runnerGroupId: "group-1",
          concurrency: 17,
          retryLimit: 2,
        }),
        items: [{ id: "new-3", caseDefinitionId: "case-1" }],
        ddtItems: [{ id: "new-4", ddtCaseId: "ddt-1" }],
        roundRecoveryCredentials: { "new-2": "target-ciphertext" },
      }),
    );
    expect(cipher.decrypt).toHaveBeenCalledWith(
      "source-ciphertext",
      "case-suite-round-recovery:source-suite:recovery-1",
    );
    expect(cipher.encrypt).toHaveBeenCalledWith(
      "jenkins-user:token",
      "case-suite-round-recovery:new-1:new-2",
    );
  });

  it.each(["queued", "dispatching", "scheduled", "running"] as const)(
    "rejects a %s batch before reading members",
    async (status) => {
      const { service, repository } = fixture({ status });
      await expect(
        service.createFromFinalFailures("batch-1", { name: "Failures" }),
      ).rejects.toMatchObject({ code: "RUN_BATCH_NOT_TERMINAL" });
      expect(repository.listFinalFailureMemberPage).not.toHaveBeenCalled();
      expect(repository.copySuite).not.toHaveBeenCalled();
    },
  );

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "accepts the %s terminal state",
    async (status) => {
      const { service } = fixture({ status });
      await expect(
        service.createFromFinalFailures("batch-1", { name: "Failures" }),
      ).resolves.toMatchObject({ id: "created-suite" });
    },
  );

  it("reads large failure selections with a bounded cursor and deduplicates DDT members", async () => {
    const { service, repository } = fixture();
    repository.listFinalFailureMemberPage
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({
          runId: `run-${index}`,
          caseId: `case-${index}`,
          caseType: "testng",
          available: true,
          createdAt: "2026-10-06T00:00:00.000Z",
        })),
      )
      .mockResolvedValueOnce([
        { runId: "run-500", caseId: "ddt-1", caseType: "ddt", available: true },
        { runId: "run-501", caseId: "ddt-1", caseType: "ddt", available: true },
      ]);
    await service.createFromFinalFailures("batch-1", { name: "Failures" });
    expect(repository.listFinalFailureMemberPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 500, afterRunId: "run-499" }),
    );
    expect(repository.copySuite.mock.calls[0]![0].items).toHaveLength(500);
    expect(repository.copySuite.mock.calls[0]![0].ddtItems).toHaveLength(1);
  });

  it.each([
    ["empty", [], "RUN_BATCH_NO_FINAL_FAILURES"],
    [
      "deleted",
      [
        {
          runId: "run-1",
          caseId: "gone",
          caseType: "testng",
          available: false,
          createdAt: "2026-10-06T00:00:00.000Z",
        },
      ],
      "CASE_SUITE_FAILURE_MEMBER_UNAVAILABLE",
    ],
  ])("rejects %s selections without persisting a partial task", async (_label, members, code) => {
    const { service, repository } = fixture();
    repository.listFinalFailureMemberPage.mockResolvedValue(members);
    await expect(
      service.createFromFinalFailures("batch-1", { name: "Failures" }),
    ).rejects.toMatchObject({ code });
    expect(repository.copySuite).not.toHaveBeenCalled();
  });

  it("rejects out-of-scope batches, missing configuration, diagnostic batches and archived versions", async () => {
    const { service, repository, structures } = fixture();
    repository.getFailureCopySource.mockResolvedValueOnce(null);
    await expect(
      service.createFromFinalFailures("batch-1", { name: "Failures" }, undefined, []),
    ).rejects.toMatchObject({ code: "RUN_BATCH_NOT_FOUND" });
    repository.getFailureCopySource.mockResolvedValueOnce({
      ...fixture().source,
      policy: undefined,
    });
    await expect(
      service.createFromFinalFailures("batch-1", { name: "Failures" }),
    ).rejects.toMatchObject({ code: "RUN_RERUN_SOURCE_INVALID" });
    repository.getFailureCopySource.mockResolvedValueOnce({
      ...fixture().source,
      kind: "case_log_rerun",
    });
    await expect(
      service.createFromFinalFailures("batch-1", { name: "Failures" }),
    ).rejects.toMatchObject({ code: "RUN_RERUN_SOURCE_INVALID" });
    structures.list.mockResolvedValueOnce({
      versions: [{ id: "version-1", projectId: "project-1", status: "archived" }],
    });
    await expect(
      service.createFromFinalFailures("batch-1", { name: "Failures" }),
    ).rejects.toMatchObject({ code: "PROJECT_VERSION_ARCHIVED" });
    expect(repository.copySuite).not.toHaveBeenCalled();
  });
});
