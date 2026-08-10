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
});

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
