import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DdtCase } from "@autoforge/domain";
import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  JarObjectStorePort,
  ProjectStructureRepository,
  RunBatchRepository,
  RunnerRepository,
} from "../src/ports";
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
  it("snapshots one DDT identity, current data and associated class through normal scheduling", async () => {
    const { service, getCase, create, item } = fixture();
    await service.createSingleDdtCase(scope, item.caseId, {
      ...input,
      projectId: "untrusted-project",
    });
    expect(getCase).toHaveBeenCalledWith(scope, item.caseId);
    const json = `${JSON.stringify(item.data)}\n`;
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: scope.projectId,
        suiteId: `single:${item.id}`,
        suiteName: `单用例 · ${item.caseId}`,
        suiteVersion: item.revision,
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
            classData: {
              json,
              sizeBytes: Buffer.byteLength(json),
              sha256: createHash("sha256").update(json).digest("hex"),
            },
          }),
        ],
      }),
    );
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
    },
    inspection: { executable: true },
  });
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
    {} as CaseSuiteRepository,
    runners,
    { now: () => new Date("2026-09-09T00:00:00Z") },
    { next: () => "generated" },
    { maximumCpuUtilizationPercent: 85, maximumMemoryUtilizationPercent: 85, maximumLoadPerCpu: 1 },
    45,
    {
      catalog,
      objectStore: { exists: vi.fn().mockResolvedValue(true) } as unknown as JarObjectStorePort,
      ddt: { getCase },
    },
    128,
    5,
    structure,
  );
  return { service, getCase, create, item, definition, getSource };
}
