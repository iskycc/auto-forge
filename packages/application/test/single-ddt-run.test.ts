import { describe, expect, it, vi } from "vitest";
import type { CaseSuiteDetails, DdtCase } from "@autoforge/domain";
import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  JarObjectStorePort,
  ProjectStructureRepository,
  RunBatchRepository,
  RunnerRepository,
} from "../src/ports";
import { createCaseDebugRunSchema } from "@autoforge/contracts";
import { RunBatchSchedulingService } from "../src/schedule-run-batches";

const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
const input = {
  runnerIds: ["runner"],
  adapter: {
    enabled: true,
    suiteName: "DDT",
    testName: "single",
    environmentAddresses: ["10.0.0.1"],
  },
};

describe("single DDT execution", () => {
  it("allows ordinary debug, immediate and suite execution without DDT Runner capabilities", async () => {
    const { service, runners, create, suite } = fixture();
    suite.ddtItems = [];
    const registered = await runners.listByIds(["runner"], "2026-09-09T00:00:00Z");
    vi.mocked(runners.listByIds).mockResolvedValue(
      registered.map((runner) => ({
        ...runner,
        capabilities: runner.capabilities.filter(
          (capability) => !capability.startsWith("adapter:ddt-"),
        ),
      })),
    );
    expect((await service.preflight({ suiteId: suite.id })).blockers).toEqual([]);
    await service.create({ suiteId: suite.id });
    await service.createSingleCase("class", { ...input, projectId: scope.projectId });
    await service.createDebugCase(
      createCaseDebugRunSchema.parse({
        ...scope,
        kind: "testng",
        caseDefinitionId: "class",
        execution: input,
      }),
    );
    expect(create).toHaveBeenCalledTimes(3);
  });
  it("rejects an older Runner before execution instead of silently losing the DDT API URL", async () => {
    const { service, runners, create, item } = fixture();
    const registered = await runners.listByIds(["runner"], "2026-09-09T00:00:00Z");
    vi.mocked(runners.listByIds).mockResolvedValue(
      registered.map((runner) => ({
        ...runner,
        capabilities: runner.capabilities.filter(
          (capability) => capability !== "adapter:ddt-insight-url-v1",
        ),
      })),
    );
    await expect(service.createSingleDdtCase(scope, item.caseId, input)).rejects.toThrow(
      "升级 Runner",
    );
    expect(create).not.toHaveBeenCalled();
  });
  it("snapshots the DDT CaseID and associated class without creating a JSON data file", async () => {
    const { service, getCase, create, item } = fixture();
    await service.createSingleDdtCase(scope, item.caseId, {
      ...input,
      projectId: "untrusted-project",
    });
    expect(getCase).toHaveBeenCalledWith(scope, item.caseId);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: scope.projectId,
        suiteId: `single:${item.id}`,
        suiteName: `单用例 · ${item.caseId}`,
        suiteVersion: item.revision,
        retryMode: "round",
        retryLimit: 0,
        policy: expect.objectContaining({
          concurrency: 1,
          projectVersionId: scope.projectVersionId,
        }),
        runs: [
          expect.objectContaining({
            caseDefinitionId: item.id,
            executionCaseDefinitionId: "class",
            caseType: "ddt",
            displayName: item.caseId,
            caseVersion: 3,
            ddtSrNum: "SR-1",
            parameters: {},
          }),
        ],
      }),
    );
    expect(create.mock.calls[0]![0].runs[0]).not.toHaveProperty("classData");
  });

  it.each([
    ["missing", "DDT_CASE_NOT_FOUND"],
    ["unmapped", "DDT_EXECUTION_CLASS_REQUIRED"],
    ["disabled", "CASE_DEFINITION_DISABLED"],
    ["wrong-stage", "DDT_EXECUTION_CLASS_UNAVAILABLE"],
    ["source-only", "CASE_SOURCE_NOT_EXECUTABLE"],
    ["no-adapter", "DDT_ADAPTER_REQUIRED"],
  ])("rejects %s before creating a batch", async (condition, code) => {
    const { service, getCase, create, item, definition, getSource } = fixture();
    if (condition === "missing") getCase.mockResolvedValue(null);
    if (condition === "unmapped") delete item.executionClass;
    if (condition === "disabled") definition.enabled = false;
    if (condition === "wrong-stage") definition.testStageId = "other-stage";
    if (condition === "source-only")
      getSource.mockResolvedValue({ inspection: { executable: false }, source: {} });
    await expect(
      service.createSingleDdtCase(
        scope,
        item.caseId,
        condition === "no-adapter" ? { runnerIds: ["runner"] } : input,
      ),
    ).rejects.toMatchObject({ code });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("case debug execution", () => {
  it("executes a formal TestNG case with the normal immutable execution snapshot", async () => {
    const { service, create } = fixture();
    await service.createDebugCase(
      createCaseDebugRunSchema.parse({
        ...scope,
        kind: "testng",
        caseDefinitionId: "class",
        execution: { runnerIds: ["runner"] },
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteName: "用例调试 · Test",
        retryLimit: 0,
        runs: [
          expect.objectContaining({
            caseDefinitionId: "class",
            caseVersion: 3,
            className: "example.Test",
          }),
        ],
      }),
    );
  });

  it("uses an explicit class for an unlinked DDT case without changing its SR mapping", async () => {
    const { service, create, item } = fixture();
    delete item.executionClass;
    await service.createDebugCase(
      createCaseDebugRunSchema.parse({
        ...scope,
        kind: "ddt",
        caseDefinitionId: "class",
        ddtCaseId: item.caseId,
        execution: input,
      }),
      "owner",
    );
    expect(item.executionClass).toBeUndefined();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteName: `用例调试 · ${item.caseId}`,
        runs: [
          expect.objectContaining({
            displayName: item.caseId,
            executionCaseDefinitionId: "class",
            caseType: "ddt",
            parameters: {},
          }),
        ],
      }),
    );
    expect(create.mock.calls[0]![0].runs[0]).not.toHaveProperty("classData");
  });

  it("does not overwrite an existing SR association when another class is selected", async () => {
    const { service, item, create } = fixture();
    item.executionClass!.caseDefinitionId = "formal-sr-class";
    await service.createDebugCase(
      createCaseDebugRunSchema.parse({
        ...scope,
        kind: "ddt",
        caseDefinitionId: "class",
        ddtCaseId: item.caseId,
        execution: input,
      }),
      "owner",
    );
    expect(item.executionClass!.caseDefinitionId).toBe("formal-sr-class");
    expect(create.mock.calls[0]![0].runs[0].executionCaseDefinitionId).toBe("class");
  });

  it.each(["wrong-version", "wrong-stage", "missing-ddt", "disabled-class"])(
    "rejects %s without creating an execution",
    async (condition) => {
      const { service, create, definition, getCase, item } = fixture();
      if (condition === "wrong-version") definition.projectVersionId = "other-version";
      if (condition === "wrong-stage") definition.testStageId = "other-stage";
      if (condition === "missing-ddt") getCase.mockResolvedValue(null);
      if (condition === "disabled-class") definition.enabled = false;
      await expect(
        service.createDebugCase(
          createCaseDebugRunSchema.parse({
            ...scope,
            kind: "ddt",
            caseDefinitionId: "class",
            ddtCaseId: item.caseId,
            execution: input,
          }),
          "owner",
        ),
      ).rejects.toMatchObject({
        code:
          condition === "missing-ddt"
            ? "DDT_CASE_NOT_FOUND"
            : condition === "disabled-class"
              ? "CASE_DEFINITION_DISABLED"
              : "CASE_DEFINITION_NOT_FOUND",
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
});

describe("DDT task execution", () => {
  it.each(["mixed", "ddt-only"] as const)(
    "creates one %s batch with independent CaseIDs for DDT cases sharing a class",
    async (kind) => {
      const { service, create, suite, item, getSuite } = fixture();
      if (kind === "ddt-only") suite.items = [];
      const second = {
        ...item,
        id: "ddt-second",
        caseId: "DDT-002",
        data: { ...item.data, CaseID: "DDT-002", value: "second" },
      };
      suite.ddtItems.push({
        id: "member-second",
        suiteId: suite.id,
        addedAt: item.createdAt,
        ddtCase: second,
      });
      expect((await service.preflight({ suiteId: suite.id })).blockers).toEqual([]);
      getSuite.mockClear();
      await service.create({ suiteId: suite.id });
      expect(getSuite).toHaveBeenCalledTimes(1);
      const batch = create.mock.calls[0]![0];
      expect(batch.runs.map((run: { caseDefinitionId: string }) => run.caseDefinitionId)).toEqual(
        kind === "mixed" ? ["class", "ddt-case", "ddt-second"] : ["ddt-case", "ddt-second"],
      );
      for (const run of batch.runs) expect(run).not.toHaveProperty("classData");
      expect(new Set(batch.runs.map((run: { id: string }) => run.id)).size).toBe(batch.runs.length);
      expect(batch.runs.filter((run: { caseType: string }) => run.caseType === "ddt")).toEqual([
        expect.objectContaining({
          executionCaseDefinitionId: "class",
          className: "example.Test",
          ddtSrNum: "SR-1",
          displayName: item.caseId,
        }),
        expect.objectContaining({
          executionCaseDefinitionId: "class",
          className: "example.Test",
          ddtSrNum: "SR-1",
          displayName: second.caseId,
        }),
      ]);
    },
  );

  it.each(["unmapped", "disabled", "archived", "empty-class", "ordinary-empty-class"])(
    "rejects the entire task for %s without scheduling any members",
    async (condition) => {
      const { service, create, suite, item } = fixture();
      if (condition === "unmapped") delete item.executionClass;
      if (condition === "disabled") item.executionClass!.enabled = false;
      if (condition === "archived") item.executionClass!.archived = true;
      if (condition === "empty-class") item.executionClass!.className = "  ";
      if (condition === "ordinary-empty-class") suite.items[0]!.caseDefinition.className = "";
      const result = await service.preflight({ suiteId: suite.id });
      expect(result.ready).toBe(false);
      expect(
        result.blockers.some((blocker) =>
          /EXECUTION_CLASS_(REQUIRED|UNAVAILABLE)/.test(blocker.code),
        ),
      ).toBe(true);
      await expect(service.create({ suiteId: suite.id })).rejects.toMatchObject({
        code: "RUN_BATCH_PREFLIGHT_FAILED",
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
});

function fixture() {
  const item: DdtCase = {
    ...scope,
    id: "ddt-case",
    caseId: "DDT-001",
    srNum: "SR-1",
    kind: "standard",
    revision: 2,
    sourceName: "cases.csv",
    updatedAt: "2026-09-09T00:00:00Z",
    createdAt: "2026-09-09T00:00:00Z",
    data: { CaseID: "DDT-001", srNum: "SR-1", value: "current" },
    executionClass: {
      caseDefinitionId: "class",
      className: "example.Test",
      displayName: "Test",
      sourceId: "source",
      currentVersion: 2,
      enabled: true,
      archived: false,
    },
  };
  const definition = {
    ...scope,
    id: "class",
    sourceId: "source",
    className: "example.Test",
    displayName: "Test",
    enabled: true,
    archived: false,
    currentVersion: 3,
    parameters: { CLASS_DEFAULT: "metadata" },
    methods: [{ enabled: true }],
  };
  const getCase = vi
    .fn<(requestedScope: typeof scope, caseId: string) => Promise<DdtCase | null>>()
    .mockResolvedValue(item);
  const getSource = vi.fn().mockResolvedValue({
    source: {
      projectId: "project",
      status: "ready",
      lifecycleStatus: "active",
      objectKey: "jar",
      sha256: "a".repeat(64),
      sizeBytes: 10,
    },
    inspection: { executable: true },
  });
  const suite = {
    id: "suite",
    projectId: scope.projectId,
    name: "Mixed task",
    version: 1,
    revision: 1,
    status: "active",
    enabled: true,
    policy: {
      executor: "testng",
      adapter: input.adapter,
      projectVersionId: scope.projectVersionId,
      runnerIds: input.runnerIds,
      runnerLabels: [],
      concurrency: 4,
      priority: 0,
      retryLimit: 0,
      retryMode: "immediate",
      retryConcurrencyRules: [],
      roundRecoveryRules: [],
      queueTimeoutMs: 86400000,
      claimTimeoutMs: 300000,
      uploadTimeoutMs: 600000,
      artifactPatterns: [],
    },
    items: [
      {
        id: "ordinary-member",
        suiteId: "suite",
        addedAt: item.createdAt,
        caseDefinition: definition,
      },
    ],
    ddtItems: [{ id: "ddt-member", suiteId: "suite", addedAt: item.createdAt, ddtCase: item }],
  } as unknown as CaseSuiteDetails;
  const getSuite = vi.fn().mockResolvedValue(suite);
  let nextId = 0;
  const create = vi.fn();
  const batches = {
    create,
    hasSchedulableRuns: vi.fn().mockResolvedValue(false),
    getSummary: vi.fn().mockResolvedValue({ id: "batch" }),
  } as unknown as RunBatchRepository;
  const runners = {
    listByIds: vi.fn().mockResolvedValue([
      {
        id: "runner",
        state: "online",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        capabilities: [
          "executor:testng-v1",
          "adapter:cotest-testng-v1",
          "adapter:ddt-insight-url-v1",
          "adapter:ddt-case-id-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
        ],
        labels: ["java", "testng"],
      },
    ]),
  } as unknown as RunnerRepository;
  const catalog = {
    getCaseDefinition: vi.fn().mockResolvedValue(definition),
    getSource,
  } as unknown as CaseCatalogRepository;
  const structure = {
    list: vi.fn().mockResolvedValue({ versions: [{ id: "version", status: "active" }] }),
    getAdapterConfiguration: vi
      .fn()
      .mockResolvedValue({ jarBundleAsset: { sourceType: "upload", objectKey: "bundle" } }),
  } as unknown as ProjectStructureRepository;
  const service = new RunBatchSchedulingService(
    batches,
    { get: getSuite } as unknown as CaseSuiteRepository,
    runners,
    { now: () => new Date("2026-09-09T00:00:00Z") },
    { next: () => `generated-${++nextId}` },
    { maximumCpuUtilizationPercent: 85, maximumMemoryUtilizationPercent: 85, maximumLoadPerCpu: 1 },
    45,
    {
      catalog,
      objectStore: { exists: vi.fn().mockResolvedValue(true) } as unknown as JarObjectStorePort,
      ddt: { getCase },
      ddtDebug: {
        get: getCase,
        workspace: async () => ({
          ownerUserId: "owner",
          accessKey: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        }),
      },
    },
    128,
    5,
    structure,
  );
  return { service, getCase, create, item, definition, getSource, suite, getSuite, runners };
}
