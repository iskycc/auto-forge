import { describe, expect, it, vi } from "vitest";

import type { RoundRecoveryRule } from "@autoforge/domain";

import { RunBatchSchedulingService } from "../src/schedule-run-batches";
import type {
  CaseCatalogRepository,
  CaseSuiteRepository,
  JarObjectStorePort,
  ProjectStructureRepository,
  RunBatchRepository,
  RunnerGroupRepository,
  RunnerRepository,
} from "../src/ports";

const timestamp = "2026-08-09T00:00:00.000Z";

describe("run batch preflight", () => {
  it("returns every structural input problem without touching repositories", async () => {
    const service = preflightService({
      suites: { get: vi.fn() } as unknown as CaseSuiteRepository,
      runners: {} as RunnerRepository,
      catalog: {} as CaseCatalogRepository,
      objectStore: {} as JarObjectStorePort,
    });

    const result = await service.preflight({ retryLimit: 99 });

    expect(result.ready).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toEqual([
      "EXECUTION_PARAMETER_INVALID",
      "EXECUTION_PARAMETER_INVALID",
    ]);
  });

  it("aggregates Runner, toolchain and authoritative JAR blockers", async () => {
    const suites = {
      get: vi.fn().mockResolvedValue({
        id: "suite-1",
        projectId: "project-1",
        name: "Smoke",
        version: 1,
        status: "active",
        enabled: true,
        policy: {
          executor: "testng",
          adapter: { enabled: false, suiteName: "", testName: "", environmentAddresses: [] },
          priority: 0,
          concurrency: 4,
          retryLimit: 0,
          retryMode: "immediate",
          queueTimeoutMs: 86_400_000,
          runnerIds: ["runner-1"],
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
    const service = preflightService({ suites, runners, catalog, objectStore });

    const result = await service.preflight({ suiteId: "suite-1" });

    expect(result.ready).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "CASE_SOURCE_OBJECT_MISSING",
        "RUNNER_JAVA_VERSION_UNKNOWN",
        "RUNNER_TESTNG_VERSION_UNKNOWN",
        "RUNNER_REQUIRED_LABEL_MISSING",
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
        catalog,
        objectStore: {} as JarObjectStorePort,
      });

      const result = await service.preflight({ suiteId: "suite-1" });

      expect(result.ready).toBe(false);
      expect(result.blockers.map((entry) => entry.code)).toContain(expected);
    }
    expect(catalog.getSource).not.toHaveBeenCalled();
  });

  it("blocks legacy suites without a project version and cross-version members", async () => {
    for (const [suite, expectedCode] of [
      [readySuite({ policy: { projectVersionId: undefined } }), "CASE_SUITE_VERSION_REQUIRED"],
      [readySuite({ caseProjectVersionId: "version-2" }), "CASE_SUITE_VERSION_MISMATCH"],
    ] as const) {
      const service = preflightService({
        suites: { get: vi.fn().mockResolvedValue(suite) } as unknown as CaseSuiteRepository,
        runners: runnersFake(),
        catalog: readyCatalogFake(),
        objectStore: { exists: vi.fn().mockResolvedValue(true) } as unknown as JarObjectStorePort,
      });

      const result = await service.preflight({ suiteId: "suite-1" });

      expect(result.ready).toBe(false);
      expect(result.blockers.map((entry) => entry.code)).toContain(expectedCode);
    }
  });

  it("blocks suites bound to an archived project version", async () => {
    const projectStructures = {
      list: vi.fn().mockResolvedValue({
        versions: [
          {
            id: "version-1",
            projectId: "project-1",
            name: "V1",
            status: "archived",
            revision: 2,
            createdAt: timestamp,
            updatedAt: timestamp,
            stages: [],
            adapterConfiguration: {
              projectId: "project-1",
              projectVersionId: "version-1",
              revision: 1,
              updatedAt: timestamp,
            },
          },
        ],
        adapterConfiguration: {
          projectId: "project-1",
          revision: 1,
          updatedAt: timestamp,
        },
      }),
    } as unknown as ProjectStructureRepository;
    const service = preflightService({
      suites: { get: vi.fn().mockResolvedValue(readySuite({})) } as unknown as CaseSuiteRepository,
      runners: runnersFake(),
      catalog: readyCatalogFake(),
      objectStore: { exists: vi.fn().mockResolvedValue(true) } as unknown as JarObjectStorePort,
      projectStructures,
    });

    const result = await service.preflight({ suiteId: "suite-1" });

    expect(result.blockers.map((entry) => entry.code)).toContain("CASE_SUITE_VERSION_UNAVAILABLE");
  });

  it("reports runners missing the suite policy labels", async () => {
    const service = preflightService({
      suites: {
        get: vi.fn().mockResolvedValue(readySuite({ runnerLabels: ["gpu"] })),
      } as unknown as CaseSuiteRepository,
      runners: runnersFake(),
      catalog: readyCatalogFake(),
      objectStore: { exists: vi.fn().mockResolvedValue(true) } as unknown as JarObjectStorePort,
    });

    const result = await service.preflight({ suiteId: "suite-1" });

    expect(result.ready).toBe(false);
    const labelBlockers = result.blockers.filter(
      (entry) => entry.code === "RUNNER_REQUIRED_LABEL_MISSING",
    );
    expect(labelBlockers.map((entry) => entry.message)).toEqual(["执行机缺少必需标签 gpu。"]);
  });

  it("allows runners without cgroup v2 isolation and keeps execution unblocked", async () => {
    const service = preflightService({
      suites: {
        get: vi.fn().mockResolvedValue(readySuite({})),
      } as unknown as CaseSuiteRepository,
      runners: runnersFake(["executor:testng-v1", "java:21.0.8", "testng:7.11.0"]),
      catalog: readyCatalogFake(),
      objectStore: { exists: vi.fn().mockResolvedValue(true) } as unknown as JarObjectStorePort,
    });

    const result = await service.preflight({ suiteId: "suite-1" });

    expect(result.blockers.map((entry) => entry.code)).not.toContain(
      "RUNNER_RESOURCE_ISOLATION_MISSING",
    );
    expect(result.ready).toBe(true);
  });

  it("blocks source-only JAR cases because they are viewable but not executable", async () => {
    const catalog = readyCatalogFake();
    const sourceRecord = await catalog.getSource("source-1");
    vi.mocked(catalog.getSource).mockResolvedValue({
      ...sourceRecord!,
      inspection: {
        discoveryMode: "java-source-annotations",
        executable: false,
      },
    } as Awaited<ReturnType<CaseCatalogRepository["getSource"]>>);
    const service = preflightService({
      suites: {
        get: vi.fn().mockResolvedValue(readySuite({})),
      } as unknown as CaseSuiteRepository,
      runners: runnersFake(),
      catalog,
      objectStore: objectStoreFake(),
    });

    const result = await service.preflight({ suiteId: "suite-1" });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "CASE_SOURCE_NOT_EXECUTABLE" }),
    );
  });

  it("requires the container executor capability for a container suite", async () => {
    const service = preflightService({
      suites: {
        get: vi.fn().mockResolvedValue(readySuite({ policy: { executor: "testng-container" } })),
      } as unknown as CaseSuiteRepository,
      runners: runnersFake(),
      catalog: readyCatalogFake(),
      objectStore: objectStoreFake(),
    });

    const result = await service.preflight({ suiteId: "suite-1" });

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "RUNNER_CONTAINER_CAPABILITY_MISSING" }),
      ]),
    );
  });

  it("requires a project dependency archive for an Adapter task", async () => {
    const service = preflightService({
      suites: {
        get: vi.fn().mockResolvedValue(
          readySuite({
            policy: {
              adapter: {
                enabled: true,
                suiteName: "suite",
                testName: "test",
                environmentAddresses: ["10.0.0.11"],
              },
            },
          }),
        ),
      } as unknown as CaseSuiteRepository,
      runners: runnersFake(),
      catalog: readyCatalogFake(),
      objectStore: objectStoreFake(),
      projectStructures: {
        list: vi.fn().mockResolvedValue(activeProjectStructure()),
        getAdapterConfiguration: vi.fn().mockResolvedValue({
          projectId: "project-1",
          revision: 0,
          updatedAt: timestamp,
        }),
      } as unknown as ProjectStructureRepository,
    });

    const result = await service.preflight({ suiteId: "suite-1" });

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ADAPTER_DEPENDENCY_ARCHIVE_MISSING" }),
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
        runnerLabels: [],
        artifactPatterns: ["reports/**"],
        retryMode: "round",
        roundRecoveryRules: [
          {
            id: "recovery-app",
            afterRound: 1,
            jenkinsJobUrl: "https://jenkins.internal/job/reset-app/",
            waitMinutes: 3,
            apiKeyConfigured: true,
          },
          {
            id: "recovery-database",
            afterRound: 1,
            jenkinsJobUrl: "https://jenkins.internal/job/reset-database/",
            waitMinutes: 7,
            apiKeyConfigured: true,
          },
        ],
      },
    });
    const suites = {
      get: vi.fn().mockResolvedValue(suite),
      getRoundRecoveryCredentials: vi.fn().mockResolvedValue({
        "recovery-app": "encrypted-app",
        "recovery-database": "encrypted-database",
      }),
    } as unknown as CaseSuiteRepository;
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
      getSummary: vi.fn().mockResolvedValue({ id: "batch-1" }),
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
      { catalog: readyCatalogFake(), objectStore: objectStoreFake() },
    );

    await service.create({ suiteId: "suite-1" });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      priority: 3,
      retryLimit: 2,
      queueTimeoutMs: 60_000,
      executionTimeoutMs: 600_000,
      policy: { concurrency: 2, runnerLabels: [], artifactPatterns: ["reports/**"] },
      roundRecoveries: [
        expect.objectContaining({ ruleId: "recovery-app", afterRound: 1, waitMinutes: 3 }),
        expect.objectContaining({ ruleId: "recovery-database", afterRound: 1, waitMinutes: 7 }),
      ],
      runs: [{ parameters: { SHARED: "case" } }],
    });
  });

  it("persists an authoritative delayed start and refuses early direct scheduling", async () => {
    const created: Array<{ scheduledFor: string }> = [];
    const reserveAssignments = vi.fn();
    const batches = {
      create: vi.fn(async (record: { scheduledFor: string }) => {
        created.push(record);
        return { id: "batch-1" };
      }),
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: {
          id: "batch-1",
          scheduledFor: "2026-08-09T00:05:00.000Z",
          assignedRuns: 0,
          secretBindings: [],
        },
        queuedRuns: [queuedRun("run-1")],
        candidates: [{ runner: schedulingRunner(), reservedSlots: 0 }],
        projectActiveRuns: 0,
      }),
      reserveAssignments,
      getSummary: vi.fn().mockResolvedValue({
        id: "batch-1",
        scheduledFor: "2026-08-09T00:05:00.000Z",
      }),
    } as unknown as RunBatchRepository;
    const service = new RunBatchSchedulingService(
      batches,
      { get: vi.fn().mockResolvedValue(readySuite({})) } as unknown as CaseSuiteRepository,
      runnersFake(),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
      { catalog: readyCatalogFake(), objectStore: objectStoreFake() },
    );

    await service.create({ suiteId: "suite-1", delaySeconds: 300 });

    expect(created[0]?.scheduledFor).toBe("2026-08-09T00:05:00.000Z");
    expect(reserveAssignments).not.toHaveBeenCalled();
  });

  it("drops saved artifact patterns when global artifact collection is disabled", async () => {
    let artifactCollectionEnabled = false;
    const suite = readySuite({
      policy: { artifactPatterns: ["reports/**"] },
    });
    const created: Array<{ policy: { artifactPatterns: string[] } }> = [];
    const batches = {
      create: vi.fn(async (record: { policy: { artifactPatterns: string[] } }) => {
        created.push(record);
        return { id: "batch-1" };
      }),
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: { assignedRuns: 0, secretBindings: [] },
        queuedRuns: [],
        candidates: [],
        projectActiveRuns: 0,
      }),
      getSummary: vi.fn().mockResolvedValue({ id: "batch-1" }),
      get: vi.fn().mockResolvedValue({ id: "batch-1" }),
    } as unknown as RunBatchRepository;
    const service = new RunBatchSchedulingService(
      batches,
      { get: vi.fn().mockResolvedValue(suite) } as unknown as CaseSuiteRepository,
      runnersFake(),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
      { catalog: readyCatalogFake(), objectStore: objectStoreFake() },
      128,
      5,
      undefined,
      undefined,
      600_000,
      () => artifactCollectionEnabled,
    );

    await service.create({ suiteId: "suite-1" });
    expect(created[0]?.policy.artifactPatterns).toEqual([]);

    artifactCollectionEnabled = true;
    await service.create({ suiteId: "suite-1" });
    expect(created[1]?.policy.artifactPatterns).toEqual(["reports/**"]);
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
      { catalog: readyCatalogFake(), objectStore: objectStoreFake() },
    );

    await expect(service.create({ suiteId: "suite-1" })).rejects.toMatchObject({
      code: "RUN_BATCH_PREFLIGHT_FAILED",
    });
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
      recordRoundConcurrency: vi.fn().mockResolvedValue("created"),
      reserveAssignments: vi.fn(async (input: { decisions: unknown[] }) => {
        decisions.push(...input.decisions);
        return input.decisions.length;
      }),
      appendSchedulingEvents: vi.fn().mockResolvedValue(undefined),
      getSummary: vi.fn().mockResolvedValue({ id: "batch-1", assignedRuns: 3 }),
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

  it("applies the first dynamic concurrency rule matching the current retry context", async () => {
    const decisions: unknown[] = [];
    const activateRetryConcurrency = vi.fn(
      async (input: { state: { concurrency: number } }) => input.state,
    );
    const batches = {
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: {
          id: "batch-1",
          currentRound: 3,
          assignedRuns: 0,
          queuedRuns: 4,
          secretBindings: [],
          policy: {
            concurrency: 8,
            runnerLabels: [],
            artifactPatterns: [],
            retryConcurrencyRules: [
              {
                id: "low-pass-remainder",
                executionRound: 3,
                previousRoundPassRateMaximum: 20,
                remainingRunsMinimum: 4,
                concurrency: 2,
              },
              {
                id: "third-round",
                executionRound: 3,
                concurrency: 6,
              },
            ],
          },
        },
        queuedRuns: [
          queuedRun("run-1"),
          queuedRun("run-2"),
          queuedRun("run-3"),
          queuedRun("run-4"),
        ],
        candidates: [{ runner: schedulingRunner(), reservedSlots: 0 }],
        projectActiveRuns: 0,
        retryContext: {
          executionRound: 3,
          previousRoundPassRate: 20,
          remainingRuns: 4,
        },
      }),
      recordRoundConcurrency: vi.fn().mockResolvedValue("created"),
      activateRetryConcurrency,
      reserveAssignments: vi.fn(async (input: { decisions: unknown[] }) => {
        decisions.push(...input.decisions);
        return input.decisions.length;
      }),
      appendSchedulingEvents: vi.fn().mockResolvedValue(undefined),
      getSummary: vi.fn().mockResolvedValue({ id: "batch-1", assignedRuns: 2 }),
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
    );

    await service.schedule("batch-1");

    expect(decisions).toHaveLength(2);
    expect(activateRetryConcurrency).toHaveBeenCalledWith(
      expect.objectContaining({
        executionRound: 3,
        expectedRuleId: null,
        state: expect.objectContaining({ ruleId: "low-pass-remainder", concurrency: 2 }),
      }),
    );
    expect(batches.recordRoundConcurrency).toHaveBeenCalledWith(
      expect.objectContaining({
        round: 3,
        concurrency: 2,
        source: "rule_transition",
        ruleId: "low-pass-remainder",
        previousConcurrency: 8,
        transitionEvent: expect.objectContaining({
          payload: expect.objectContaining({ previousRoundPassRate: 20, remainingRuns: 4 }),
        }),
      }),
    );
  });

  it("keeps the activated concurrency when its condition misses in a later round", async () => {
    const decisions: unknown[] = [];
    const activateRetryConcurrency = vi.fn();
    const batches = {
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: {
          id: "batch-1",
          currentRound: 5,
          assignedRuns: 0,
          queuedRuns: 4,
          secretBindings: [],
          policy: {
            concurrency: 8,
            runnerLabels: [],
            artifactPatterns: [],
            retryConcurrencyRules: [
              {
                id: "high-pass",
                executionRound: 2,
                previousRoundPassRateMinimum: 70,
                concurrency: 2,
              },
            ],
          },
        },
        queuedRuns: [
          queuedRun("run-1"),
          queuedRun("run-2"),
          queuedRun("run-3"),
          queuedRun("run-4"),
        ],
        candidates: [{ runner: schedulingRunner(), reservedSlots: 0 }],
        projectActiveRuns: 0,
        retryConcurrencyState: {
          ruleId: "high-pass",
          ruleIndex: 0,
          concurrency: 2,
          activatedRound: 2,
        },
        retryContext: {
          executionRound: 5,
          previousRoundPassRate: 60,
          remainingRuns: 4,
        },
      }),
      recordRoundConcurrency: vi.fn().mockResolvedValue("created"),
      activateRetryConcurrency,
      reserveAssignments: vi.fn(async (input: { decisions: unknown[] }) => {
        decisions.push(...input.decisions);
        return input.decisions.length;
      }),
      appendSchedulingEvents: vi.fn().mockResolvedValue(undefined),
      getSummary: vi.fn().mockResolvedValue({ id: "batch-1", assignedRuns: 2 }),
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
    );

    await service.schedule("batch-1");

    expect(decisions).toHaveLength(2);
    expect(activateRetryConcurrency).not.toHaveBeenCalled();
    expect(batches.recordRoundConcurrency).toHaveBeenCalledWith(
      expect.objectContaining({
        round: 5,
        concurrency: 2,
        source: "inherited_rule",
        ruleId: "high-pass",
      }),
    );
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
      recordRoundConcurrency: vi.fn().mockResolvedValue("created"),
      reserveAssignments: vi.fn(),
      getSummary: vi.fn().mockResolvedValue({ id: "batch-1", assignedRuns: 0 }),
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
        projectVersionId: "version-1",
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
      getSummary: vi.fn().mockResolvedValue({ id: "generated-id", assignedRuns: 0 }),
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
      { catalog, objectStore: objectStoreFake() },
    );

    await service.createSingleCase("case-1", {
      projectId: "project-1",
      runnerIds: ["runner-1"],
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
            parameters: { CASE_DEFAULT: "yes" },
          }),
        ],
      }),
    );
  });

  it("resolves a runner group once and persists its sorted member snapshot", async () => {
    const create = vi.fn();
    const batches = {
      create,
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: { assignedRuns: 0, secretBindings: [] },
        queuedRuns: [],
        candidates: [],
        projectActiveRuns: 0,
      }),
      getSummary: vi.fn().mockResolvedValue({ id: "generated-id", assignedRuns: 0 }),
      get: vi.fn().mockResolvedValue({ id: "generated-id", assignedRuns: 0 }),
    } as unknown as RunBatchRepository;
    const runnerGroups = {
      get: vi.fn().mockResolvedValue({
        id: "group-1",
        runnerIds: ["runner-b", "runner-a"],
      }),
    } as unknown as RunnerGroupRepository;
    const runners = {
      get: vi.fn(async (runnerId: string) => ({
        ...(await runnersFake().get("runner-1", timestamp))!,
        id: runnerId,
      })),
    } as unknown as RunnerRepository;
    const service = new RunBatchSchedulingService(
      batches,
      {
        get: vi
          .fn()
          .mockResolvedValue(readySuite({ policy: { runnerIds: [], runnerGroupId: "group-1" } })),
      } as unknown as CaseSuiteRepository,
      runners,
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
      { catalog: readyCatalogFake(), objectStore: objectStoreFake() },
      128,
      5,
      undefined,
      runnerGroups,
    );

    await service.create({ suiteId: "suite-1" });

    expect(runnerGroups.get).toHaveBeenCalledWith("group-1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ runnerIds: ["runner-a", "runner-b"] }),
    );
  });

  it("persists Adapter execution addresses for a single-case batch", async () => {
    const catalog = {
      ...readyCatalogFake(),
      getCaseDefinition: vi.fn().mockResolvedValue({
        id: "case-1",
        projectId: "project-1",
        projectVersionId: "version-1",
        sourceId: "source-1",
        className: "com.example.SmokeTest",
        displayName: "Smoke",
        enabled: true,
        archived: false,
        parameters: {},
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
      getSummary: vi.fn().mockResolvedValue({ id: "generated-id", assignedRuns: 0 }),
      get: vi.fn().mockResolvedValue({ id: "generated-id", assignedRuns: 0 }),
    } as unknown as RunBatchRepository;
    const projectStructures = {
      list: vi.fn().mockResolvedValue(activeProjectStructure()),
      getAdapterConfiguration: vi.fn().mockResolvedValue({
        projectId: "project-1",
        jarBundleAsset: {
          id: "bundle-1",
          projectId: "project-1",
          kind: "jar-bundle",
          sourceType: "upload",
          fileName: "adapter.zip",
          objectKey: "projects/project-1/runtime-assets/bundle-1.zip",
          sha256: "b".repeat(64),
          sizeBytes: 1_024,
          archiveFormat: "zip",
          createdAt: timestamp,
        },
        revision: 1,
        updatedAt: timestamp,
      }),
    } as unknown as ProjectStructureRepository;
    const service = new RunBatchSchedulingService(
      batches,
      {} as CaseSuiteRepository,
      runnersFake([
        "executor:testng-v1",
        "isolation:cgroup-v2",
        "java:21.0.8",
        "testng:7.11.0",
        "adapter:cotest-testng-v1",
      ]),
      { now: () => new Date(timestamp) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
      { catalog, objectStore: objectStoreFake() },
      128,
      5,
      projectStructures,
    );

    await service.createSingleCase("case-1", {
      projectId: "project-1",
      runnerIds: ["runner-1"],
      adapter: {
        enabled: true,
        suiteName: "IP Suite",
        testName: "IP Test",
        environmentAddresses: ["10.0.0.21", "10.0.0.22"],
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        policy: expect.objectContaining({ projectVersionId: "version-1" }),
        adapter: {
          enabled: true,
          suiteName: "IP Suite",
          testName: "IP Test",
          environmentAddresses: ["10.0.0.21", "10.0.0.22"],
        },
      }),
    );
    expect(projectStructures.getAdapterConfiguration).toHaveBeenCalledWith(
      "project-1",
      "version-1",
    );
  });

  it("rejects direct execution of a source-only case", async () => {
    const catalog = {
      ...readyCatalogFake(),
      getCaseDefinition: vi.fn().mockResolvedValue({
        id: "case-1",
        projectId: "project-1",
        sourceId: "source-1",
        displayName: "SourceVisibleTest",
        enabled: true,
        archived: false,
        parameters: {},
        currentVersion: 1,
        methods: [{ enabled: true }],
      }),
      getSource: vi.fn().mockResolvedValue({
        source: (await readyCatalogFake().getSource("source-1"))?.source,
        inspection: { discoveryMode: "java-source-annotations", executable: false },
      }),
    } as unknown as CaseCatalogRepository;
    const service = new RunBatchSchedulingService(
      {} as RunBatchRepository,
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
      { catalog, objectStore: objectStoreFake() },
    );

    await expect(
      service.createSingleCase("case-1", {
        projectId: "project-1",
        runnerIds: ["runner-1"],
      }),
    ).rejects.toMatchObject({ code: "CASE_SOURCE_NOT_EXECUTABLE" });
  });
});

describe("scheduling event log", () => {
  function schedulingBatchesFake() {
    const appended: Array<Array<Record<string, unknown>>> = [];
    const batches = {
      getSchedulingSnapshot: vi.fn().mockResolvedValue({
        batch: {
          id: "batch-1",
          assignedRuns: 0,
          secretBindings: [],
          policy: { concurrency: 4, runnerLabels: [], artifactPatterns: [] },
        },
        queuedRuns: [queuedRun("run-1"), queuedRun("run-2")],
        candidates: [{ runner: schedulingRunner(), reservedSlots: 0 }],
        projectActiveRuns: 0,
      }),
      recordRoundConcurrency: vi.fn().mockResolvedValue("created"),
      reserveAssignments: vi.fn(async (input: { decisions: unknown[] }) => input.decisions.length),
      appendSchedulingEvents: vi.fn(async (events: Array<Record<string, unknown>>) => {
        appended.push(events);
      }),
      listSchedulingEvents: vi.fn().mockResolvedValue({ items: [], nextAfterId: "cursor-1" }),
      getSummary: vi.fn(async (batchId: string) =>
        batchId === "batch-1" ? { id: "batch-1", assignedRuns: 2 } : null,
      ),
      get: vi.fn(async (batchId: string) =>
        batchId === "batch-1" ? { id: "batch-1", assignedRuns: 2 } : null,
      ),
    } as unknown as RunBatchRepository;
    return { batches, appended };
  }

  function schedulingService(batches: RunBatchRepository, nowMs: number) {
    return new RunBatchSchedulingService(
      batches,
      {} as CaseSuiteRepository,
      {} as RunnerRepository,
      { now: () => new Date(nowMs) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
    );
  }

  it("writes run_assigned and batch_scheduled events after reserving", async () => {
    const { batches, appended } = schedulingBatchesFake();
    const service = schedulingService(batches, Date.parse(timestamp));

    await service.schedule("batch-1");

    expect(appended).toHaveLength(1);
    const events = appended[0]!;
    const assigned = events.filter((event) => event.eventType === "run_assigned");
    expect(assigned).toHaveLength(2);
    expect(assigned.map((event) => event.executionRunId)).toEqual(["run-1", "run-2"]);
    expect(assigned[0]).toMatchObject({
      batchId: "batch-1",
      runnerId: "runner-1",
      eventType: "run_assigned",
      recordedAt: timestamp,
    });
    expect(String(assigned[0]!.message)).toContain("调度器将用例「run-1」分配给执行机 runner-1");
    const summary = events.find((event) => event.eventType === "batch_scheduled");
    expect(summary).toMatchObject({
      batchId: "batch-1",
      eventType: "batch_scheduled",
      payload: { assignedCount: 2, queueRemaining: 0, decisions: 2 },
    });
  });

  it("throttles runner_metrics events within the 30 second window", async () => {
    const { batches, appended } = schedulingBatchesFake();
    const service = schedulingService(batches, Date.parse(timestamp));

    await service.schedule("batch-1");
    await service.schedule("batch-1");

    expect(appended).toHaveLength(2);
    const metricsFirst = appended[0]!.filter((event) => event.eventType === "runner_metrics");
    const metricsSecond = appended[1]!.filter((event) => event.eventType === "runner_metrics");
    expect(metricsFirst).toHaveLength(1);
    expect(metricsFirst[0]).toMatchObject({
      runnerId: "runner-1",
      eventType: "runner_metrics",
      // evaluation 在决策前计算（reservedSlots=0），故为 maxConcurrency 全量。
      payload: { availableSlots: 8, blockReasons: [] },
    });
    expect(String(metricsFirst[0]!.message)).toContain("执行机 runner-1 资源快照：可用槽位 8");
    expect(metricsSecond).toHaveLength(0);
  });

  it("emits runner_metrics again once the throttle window has elapsed", async () => {
    const { batches, appended } = schedulingBatchesFake();
    let nowMs = Date.parse(timestamp);
    const service = new RunBatchSchedulingService(
      batches,
      {} as CaseSuiteRepository,
      {} as RunnerRepository,
      { now: () => new Date(nowMs) },
      { next: () => "generated-id" },
      {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      },
      45,
    );

    await service.schedule("batch-1");
    nowMs += 30_000;
    await service.schedule("batch-1");

    const metricsCounts = appended.map(
      (events) => events.filter((event) => event.eventType === "runner_metrics").length,
    );
    expect(metricsCounts).toEqual([1, 1]);
  });

  it("lists scheduling events only after confirming the batch exists", async () => {
    const { batches } = schedulingBatchesFake();
    const service = schedulingService(batches, Date.parse(timestamp));

    const page = await service.listSchedulingEvents("batch-1", { limit: 10 });

    expect(batches.get).toHaveBeenCalledWith("batch-1", undefined);
    expect(page.nextAfterId).toBe("cursor-1");
    await expect(
      service.listSchedulingEvents("missing-batch", { limit: 10 }),
    ).rejects.toMatchObject({
      code: "RUN_BATCH_NOT_FOUND",
    });
  });
});

const readyPolicy = {
  executor: "testng" as "testng" | "testng-container",
  adapter: { enabled: false, suiteName: "", testName: "", environmentAddresses: [] as string[] },
  priority: 0,
  concurrency: 4,
  retryLimit: 0,
  retryMode: "immediate" as "immediate" | "round",
  queueTimeoutMs: 86_400_000,
  claimTimeoutMs: 300_000,
  uploadTimeoutMs: 600_000,
  projectVersionId: "version-1" as string | undefined,
  runnerIds: ["runner-1"] as string[],
  runnerGroupId: undefined as string | undefined,
  runnerLabels: [] as string[],
  parameters: {} as Record<string, string>,
  artifactPatterns: ["reports/testng/**"],
  retryConcurrencyRules: [],
  roundRecoveryRules: [] as RoundRecoveryRule[],
};

function readySuite(overrides: {
  status?: "active" | "archived";
  enabled?: boolean;
  runnerLabels?: string[];
  caseProjectVersionId?: string;
  policy?: Partial<typeof readyPolicy>;
}) {
  const { status, enabled, runnerLabels, caseProjectVersionId, policy } = overrides;
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
          projectVersionId: caseProjectVersionId ?? "version-1",
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

function runnersFake(
  capabilities: string[] = [
    "executor:testng-v1",
    "isolation:cgroup-v2",
    "java:21.0.8",
    "testng:7.11.0",
  ],
) {
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
      capabilities,
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
  catalog: CaseCatalogRepository;
  objectStore: JarObjectStorePort;
  projectStructures?: ProjectStructureRepository;
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
    { catalog: input.catalog, objectStore: input.objectStore },
    128,
    5,
    input.projectStructures,
  );
}

function activeProjectStructure() {
  return {
    versions: [
      {
        id: "version-1",
        projectId: "project-1",
        name: "V1",
        status: "active" as const,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        stages: [],
        adapterConfiguration: {
          projectId: "project-1",
          projectVersionId: "version-1",
          revision: 1,
          updatedAt: timestamp,
        },
      },
    ],
    adapterConfiguration: {
      projectId: "project-1",
      revision: 1,
      updatedAt: timestamp,
    },
  };
}
