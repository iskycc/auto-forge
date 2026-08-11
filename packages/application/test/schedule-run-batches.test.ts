import { describe, expect, it, vi } from "vitest";

import { RunBatchSchedulingService } from "../src/schedule-run-batches";
import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  ExecutionEnvironmentRepository,
  JarObjectStorePort,
  RunBatchRepository,
  RunnerRepository,
} from "../src/ports";

const timestamp = "2026-08-09T00:00:00.000Z";

describe("run batch preflight", () => {
  it("returns every structural input problem without touching repositories", async () => {
    const service = preflightService({
      suites: { get: vi.fn() } as unknown as CaseSuiteRepository,
      runners: {} as RunnerRepository,
      environments: {} as ExecutionEnvironmentRepository,
      catalog: {} as CaseCatalogRepository,
      objectStore: {} as JarObjectStorePort,
    });

    const result = await service.preflight({
      runnerIds: [],
      retryLimit: 99,
      environmentVariables: [{ name: "1INVALID", value: "value" }],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "EXECUTION_PARAMETER_INVALID",
        "RUNNER_SELECTION_INVALID",
        "EXECUTION_ENVIRONMENT_PARAMETER_INVALID",
      ]),
    );
  });

  it("aggregates secret, Runner, toolchain and authoritative JAR blockers", async () => {
    const suites = {
      get: vi.fn().mockResolvedValue({
        id: "suite-1",
        name: "Smoke",
        version: 1,
        status: "active",
        enabled: true,
        policy: {
          priority: 0,
          concurrency: 4,
          retryLimit: 0,
          queueTimeoutMs: 86_400_000,
          executionTimeoutMs: 3_600_000,
          runnerLabels: [],
          parameters: {},
          artifactPatterns: ["reports/testng/**"],
        },
        caseCount: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        items: [
          {
            id: "item-1",
            suiteId: "suite-1",
            addedAt: timestamp,
            caseDefinition: {
              id: "case-1",
              sourceId: "source-1",
              className: "com.example.SmokeTest",
              packageName: "com.example",
              displayName: "SmokeTest",
              enabled: true,
              groups: [],
              currentVersion: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
              methods: [],
            },
          },
        ],
      }),
    } as unknown as CaseSuiteRepository;
    const runners = {
      get: vi.fn().mockResolvedValue({
        id: "runner-1",
        name: "Runner",
        state: "online",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        labels: ["testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2"],
        maxConcurrency: 1,
        busySlots: 0,
        lastSeenAt: timestamp,
        terminalEnabled: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    } as unknown as RunnerRepository;
    const binding = {
      name: "API_TOKEN",
      secretId: "secret-1",
      secretVersionId: "secret-version-1",
    };
    const environments = {
      getVersion: vi.fn().mockResolvedValue({
        environment: { id: "environment-1", status: "active" },
        version: { id: "environment-version-1", variables: [], secretBindings: [binding] },
      }),
      findUnavailableSecretsForExecution: vi.fn().mockResolvedValue([binding]),
    } as unknown as ExecutionEnvironmentRepository;
    const catalog = {
      getSource: vi.fn().mockResolvedValue({
        source: {
          id: "source-1",
          displayName: "tests.jar",
          originalFileName: "tests.jar",
          objectKey: `jars/${"a".repeat(64)}.jar`,
          sha256: "a".repeat(64),
          sizeBytes: 1_024,
          classCount: 1,
          methodCount: 1,
          status: "ready",
          warningCount: 0,
          authoritative: true,
          createdAt: timestamp,
        },
        inspection: {},
      }),
    } as unknown as CaseCatalogRepository;
    const objectStore = {
      exists: vi.fn().mockResolvedValue(false),
    } as unknown as JarObjectStorePort;
    const service = preflightService({ suites, runners, environments, catalog, objectStore });

    const result = await service.preflight({
      suiteId: "suite-1",
      runnerIds: ["runner-1"],
      retryLimit: 0,
      environmentVersionId: "environment-version-1",
    });

    expect(result.ready).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "CASE_SOURCE_OBJECT_MISSING",
        "EXECUTION_SECRET_UNAVAILABLE",
        "RUNNER_JAVA_VERSION_UNKNOWN",
        "RUNNER_TESTNG_VERSION_UNKNOWN",
        "RUNNER_REQUIRED_LABEL_MISSING",
        "RUNNER_SECRET_CAPABILITY_MISSING",
      ]),
    );
  });

  it("blocks archived or disabled suites before inspecting execution inputs", async () => {
    const catalog = { getSource: vi.fn() } as unknown as CaseCatalogRepository;
    for (const [suiteState, expected] of [
      [{ status: "archived", enabled: true }, "CASE_SUITE_ARCHIVED"],
      [{ status: "active", enabled: false }, "CASE_SUITE_DISABLED"],
    ] as const) {
      const service = preflightService({
        suites: {
          get: vi.fn().mockResolvedValue(readySuite(suiteState)),
        } as unknown as CaseSuiteRepository,
        runners: runnersFake(),
        environments: {} as ExecutionEnvironmentRepository,
        catalog,
        objectStore: {} as JarObjectStorePort,
      });

      const result = await service.preflight({ suiteId: "suite-1", runnerIds: ["runner-1"] });

      expect(result.ready).toBe(false);
      expect(result.blockers.map((entry) => entry.code)).toContain(expected);
    }
    expect(catalog.getSource).not.toHaveBeenCalled();
  });

  it("reports runners missing the suite policy labels", async () => {
    const service = preflightService({
      suites: {
        get: vi.fn().mockResolvedValue(readySuite({ runnerLabels: ["gpu"] })),
      } as unknown as CaseSuiteRepository,
      runners: runnersFake(),
      environments: {} as ExecutionEnvironmentRepository,
      catalog: readyCatalogFake(),
      objectStore: { exists: vi.fn().mockResolvedValue(true) } as unknown as JarObjectStorePort,
    });

    const result = await service.preflight({ suiteId: "suite-1", runnerIds: ["runner-1"] });

    expect(result.ready).toBe(false);
    const labelBlockers = result.blockers.filter(
      (entry) => entry.code === "RUNNER_REQUIRED_LABEL_MISSING",
    );
    expect(labelBlockers.map((entry) => entry.message)).toEqual(["执行机缺少必需标签 gpu。"]);
  });

  it("requires the container executor capability for a container suite", async () => {
    const service = preflightService({
      suites: {
        get: vi.fn().mockResolvedValue(readySuite({ policy: { executor: "testng-container" } })),
      } as unknown as CaseSuiteRepository,
      runners: runnersFake(),
      environments: {} as ExecutionEnvironmentRepository,
      catalog: readyCatalogFake(),
      objectStore: objectStoreFake(),
    });

    const result = await service.preflight({
      projectId: "project-1",
      suiteId: "suite-1",
      runnerIds: ["runner-1"],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "RUNNER_CONTAINER_CAPABILITY_MISSING" }),
      ]),
    );
  });
});

describe("run batch creation with suite policy", () => {
  it("merges omitted execution settings from the suite policy and freezes them", async () => {
    const suite = readySuite({
      policy: {
        priority: 3,
        concurrency: 2,
        retryLimit: 2,
        queueTimeoutMs: 60_000,
        executionTimeoutMs: 120_000,
        runnerLabels: [],
        parameters: { SUITE: "template", SHARED: "suite" },
        artifactPatterns: ["reports/**"],
      },
    });
    const suites = { get: vi.fn().mockResolvedValue(suite) } as unknown as CaseSuiteRepository;
    const created: unknown[] = [];
    const batches = {
      create: vi.fn(async (record: unknown) => {
        created.push(record);
        return { id: "batch-1" };
      }),
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: { assignedRuns: 0, secretBindings: [] },
        queuedRuns: [],
        candidates: [],
        projectActiveRuns: 0,
      }),
      get: vi.fn().mockResolvedValue({ id: "batch-1" }),
    } as unknown as RunBatchRepository;
    const service = new RunBatchSchedulingService(
      batches,
      suites,
      runnersFake(),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
      undefined,
      { catalog: readyCatalogFake(), objectStore: objectStoreFake() },
    );

    await service.create({
      suiteId: "suite-1",
      runnerIds: ["runner-1"],
      environmentVariables: [],
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      priority: 3,
      retryLimit: 2,
      queueTimeoutMs: 60_000,
      executionTimeoutMs: 120_000,
      policy: { concurrency: 2, runnerLabels: [], artifactPatterns: ["reports/**"] },
      runs: [{ parameters: { SUITE: "template", SHARED: "case" } }],
    });
  });

  it("rejects creating batches for archived suites", async () => {
    const suites = {
      get: vi.fn().mockResolvedValue(readySuite({ status: "archived" })),
    } as unknown as CaseSuiteRepository;
    const service = new RunBatchSchedulingService(
      {} as RunBatchRepository,
      suites,
      runnersFake(),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
      undefined,
      { catalog: readyCatalogFake(), objectStore: objectStoreFake() },
    );

    await expect(
      service.create({ suiteId: "suite-1", runnerIds: ["runner-1"], environmentVariables: [] }),
    ).rejects.toMatchObject({ code: "RUN_BATCH_PREFLIGHT_FAILED" });
  });

  it("limits new assignments to the remaining batch concurrency budget", async () => {
    const decisions: unknown[] = [];
    const suites = { get: vi.fn() } as unknown as CaseSuiteRepository;
    const batches = {
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: {
          id: "batch-1",
          assignedRuns: 1,
          secretBindings: [],
          policy: { concurrency: 3, runnerLabels: [], artifactPatterns: ["reports/**"] },
        },
        queuedRuns: [
          queuedRun("run-1"),
          queuedRun("run-2"),
          queuedRun("run-3"),
          queuedRun("run-4"),
        ],
        candidates: [{ runner: schedulingRunner(), reservedSlots: 0 }],
        projectActiveRuns: 0,
      }),
      reserveAssignments: vi.fn(async (input: { decisions: unknown[] }) => {
        decisions.push(...input.decisions);
        return input.decisions.length;
      }),
      get: vi.fn().mockResolvedValue({ id: "batch-1", assignedRuns: 3 }),
    } as unknown as RunBatchRepository;
    const service = new RunBatchSchedulingService(
      batches,
      suites,
      {} as RunnerRepository,
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
    );

    await service.schedule("batch-1");

    expect(decisions).toHaveLength(2);
    expect(
      decisions.map((decision) => (decision as { executionRunId: string }).executionRunId),
    ).toEqual(["run-1", "run-2"]);
  });

  it("does not schedule when the project concurrency budget is exhausted", async () => {
    const batches = {
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: {
          id: "batch-1",
          assignedRuns: 0,
          secretBindings: [],
          policy: { concurrency: 4, runnerLabels: [], artifactPatterns: [] },
        },
        queuedRuns: [queuedRun("run-1")],
        candidates: [{ runner: schedulingRunner(), reservedSlots: 0 }],
        projectActiveRuns: 2,
      }),
      reserveAssignments: vi.fn(),
      get: vi.fn().mockResolvedValue({ id: "batch-1", assignedRuns: 0 }),
    } as unknown as RunBatchRepository;
    const service = new RunBatchSchedulingService(
      batches,
      {} as CaseSuiteRepository,
      {} as RunnerRepository,
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
      undefined,
      undefined,
      2,
    );

    await service.schedule("batch-1");

    expect(batches.reserveAssignments).not.toHaveBeenCalled();
  });

  it("creates a single-case batch through the shared scheduling path", async () => {
    const catalog = {
      ...readyCatalogFake(),
      getCaseDefinition: vi.fn().mockResolvedValue({
        id: "case-1",
        projectId: "project-1",
        sourceId: "source-1",
        className: "com.example.SmokeTest",
        displayName: "Smoke",
        enabled: true,
        archived: false,
        parameters: { CASE_DEFAULT: "yes" },
        currentVersion: 3,
        methods: [{ enabled: true }],
      }),
    } as unknown as CaseCatalogRepository;
    const create = vi.fn();
    const batches = {
      create,
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: { assignedRuns: 0, secretBindings: [] },
        queuedRuns: [],
        candidates: [],
        projectActiveRuns: 0,
      }),
      get: vi.fn().mockResolvedValue({ id: "generated-id", assignedRuns: 0 }),
    } as unknown as RunBatchRepository;
    const service = new RunBatchSchedulingService(
      batches,
      {} as CaseSuiteRepository,
      runnersFake(),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
      undefined,
      { catalog, objectStore: objectStoreFake() },
    );

    await service.createSingleCase("case-1", {
      projectId: "project-1",
      runnerIds: ["runner-1"],
      parameters: { OVERRIDE: "value" },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        suiteId: "single:case-1",
        policy: expect.objectContaining({ concurrency: 1 }),
        runs: [
          expect.objectContaining({
            caseDefinitionId: "case-1",
            caseVersion: 3,
            parameters: { CASE_DEFAULT: "yes", OVERRIDE: "value" },
          }),
        ],
      }),
    );
  });
});

const readyPolicy = {
  executor: "testng" as "testng" | "testng-container",
  priority: 0,
  concurrency: 4,
  retryLimit: 0,
  queueTimeoutMs: 86_400_000,
  executionTimeoutMs: 3_600_000,
  runnerLabels: [] as string[],
  parameters: {} as Record<string, string>,
  artifactPatterns: ["reports/testng/**"],
};

function readySuite(overrides: {
  status?: "active" | "archived";
  enabled?: boolean;
  runnerLabels?: string[];
  policy?: Partial<typeof readyPolicy>;
}) {
  const { status, enabled, runnerLabels, policy } = overrides;
  return {
    id: "suite-1",
    projectId: "project-1",
    name: "Smoke",
    version: 1,
    revision: 1,
    status: status ?? "active",
    enabled: enabled ?? true,
    policy: {
      ...readyPolicy,
      ...policy,
      runnerLabels: runnerLabels ?? policy?.runnerLabels ?? readyPolicy.runnerLabels,
    },
    caseCount: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    items: [
      {
        id: "item-1",
        suiteId: "suite-1",
        addedAt: timestamp,
        caseDefinition: {
          id: "case-1",
          projectId: "project-1",
          sourceId: "source-1",
          className: "com.example.SmokeTest",
          packageName: "com.example",
          displayName: "SmokeTest",
          tags: [],
          enabled: true,
          archived: false,
          groups: [],
          parameters: { SHARED: "case" },
          currentVersion: 1,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          methods: [],
        },
      },
    ],
  };
}

function runnersFake() {
  return {
    get: vi.fn().mockResolvedValue({
      id: "runner-1",
      name: "Runner",
      state: "online",
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.2.2",
      protocolVersion: 1,
      labels: ["java", "testng"],
      capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
      maxConcurrency: 4,
      busySlots: 0,
      lastSeenAt: timestamp,
      resourceSnapshot: {
        cpuUtilizationPercent: 20,
        memoryUtilizationPercent: 30,
        loadAverage1m: 0.5,
        logicalCpuCount: 1,
        observedAt: timestamp,
      },
      terminalEnabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  } as unknown as RunnerRepository;
}

function readyCatalogFake() {
  return {
    getSource: vi.fn().mockResolvedValue({
      source: {
        id: "source-1",
        projectId: "project-1",
        displayName: "tests.jar",
        originalFileName: "tests.jar",
        objectKey: `jars/${"a".repeat(64)}.jar`,
        sha256: "a".repeat(64),
        sizeBytes: 1_024,
        classCount: 1,
        methodCount: 1,
        status: "ready",
        lifecycleStatus: "active",
        warningCount: 0,
        authoritative: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      inspection: {},
    }),
  } as unknown as CaseCatalogRepository;
}

function objectStoreFake() {
  return { exists: vi.fn().mockResolvedValue(true) } as unknown as JarObjectStorePort;
}

function queuedRun(id: string) {
  return {
    id,
    batchId: "batch-1",
    caseDefinitionId: "case-1",
    caseVersion: 1,
    displayName: id,
    className: "com.example.SmokeTest",
    status: "queued" as const,
    attemptCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function schedulingRunner() {
  return {
    id: "runner-1",
    name: "Runner",
    state: "online",
    os: "linux",
    architecture: "amd64",
    agentVersion: "0.2.2",
    protocolVersion: 1,
    labels: ["java", "testng"],
    capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
    maxConcurrency: 8,
    busySlots: 0,
    lastSeenAt: timestamp,
    resourceSnapshot: {
      cpuUtilizationPercent: 20,
      memoryUtilizationPercent: 30,
      loadAverage1m: 0.5,
      logicalCpuCount: 1,
      observedAt: timestamp,
    },
    terminalEnabled: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function preflightService(input: {
  suites: CaseSuiteRepository;
  runners: RunnerRepository;
  environments: ExecutionEnvironmentRepository;
  catalog: CaseCatalogRepository;
  objectStore: JarObjectStorePort;
}) {
  return new RunBatchSchedulingService(
    {} as RunBatchRepository,
    input.suites,
    input.runners,
    { now: () => new Date(timestamp) },
    { next: () => "unused" },
    {
      maximumCpuUtilizationPercent: 85,
      maximumMemoryUtilizationPercent: 85,
      maximumLoadPerCpu: 1,
    },
    45,
    input.environments,
    { catalog: input.catalog, objectStore: input.objectStore },
  );
}
