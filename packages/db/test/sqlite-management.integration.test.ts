import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { SqliteRunnerRepository } from "../src/sqlite-runner";
import { scheduleExecutionRuns } from "@autoforge/domain";
import { RunBatchSchedulingService } from "@autoforge/application";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite management repositories", () => {
  it("switches the authoritative source and adds and removes suite cases transactionally", async () => {
    const { handle, catalog, suites } = await fixture();
    try {
      const source = await catalog.setAuthoritativeSource("source-1");
      expect(source.authoritative).toBe(true);
      expect((await catalog.getSource("source-1"))?.inspection.testMethodCount).toBe(1);

      await suites.create({ id: "suite-1", name: "Smoke", createdAt: timestamp });
      const withCase = await suites.addCases({
        suiteId: "suite-1",
        items: [{ id: "item-1", caseDefinitionId: "case-1" }],
        updatedAt: timestamp,
      });
      expect(withCase).toMatchObject({ caseCount: 1, version: 2 });
      expect(withCase.items[0]?.caseDefinition.className).toBe("com.example.SmokeTest");

      const empty = await suites.removeCase({
        suiteId: "suite-1",
        caseDefinitionId: "case-1",
        updatedAt: "2026-08-09T00:01:00.000Z",
      });
      expect(empty).toMatchObject({ caseCount: 0, version: 3 });
    } finally {
      handle.close();
    }
  });

  it("derives online and offline runner state from heartbeat time", async () => {
    const { handle, runners } = await fixture();
    try {
      await runners.register({
        id: "runner-1",
        bootstrapTokenHash: "bootstrap-hash-1",
        credentialHash: "hash-1",
        name: "linux-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.1.0",
        protocolVersion: 1,
        labels: ["java"],
        maxConcurrency: 2,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await expect(
        runners.register({
          id: "runner-duplicate",
          bootstrapTokenHash: "bootstrap-hash-1",
          credentialHash: "hash-duplicate",
          name: "duplicate",
          os: "linux",
          architecture: "amd64",
          agentVersion: "0.1.0",
          protocolVersion: 1,
          labels: [],
          maxConcurrency: 1,
          terminalEnabled: false,
          recordedAt: timestamp,
        }),
      ).resolves.toBeNull();
      expect((await runners.list("2026-08-08T23:59:00.000Z", 100))[0]?.state).toBe("online");
      expect((await runners.list("2026-08-09T00:00:30.000Z", 100))[0]?.state).toBe("offline");
      const heartbeat = await runners.heartbeat({
        runnerId: "runner-1",
        labels: ["java", "testng"],
        maxConcurrency: 2,
        busySlots: 1,
        agentVersion: "0.1.1",
        terminalEnabled: true,
        recordedAt: "2026-08-09T00:01:00.000Z",
      });
      expect(heartbeat).toMatchObject({ busySlots: 1, terminalEnabled: true });
      const terminalDisabled = await runners.heartbeat({
        runnerId: "runner-1",
        labels: ["java"],
        maxConcurrency: 2,
        busySlots: 0,
        agentVersion: "0.1.1",
        terminalEnabled: false,
        recordedAt: "2026-08-09T00:02:00.000Z",
      });
      expect(terminalDisabled.terminalEnabled).toBe(false);
    } finally {
      handle.close();
    }
  });

  it("reconstructs previews imported before inspection snapshots were persisted", async () => {
    const { handle, catalog } = await fixture();
    try {
      handle.client
        .prepare("UPDATE case_sources SET inspection_json = '{}' WHERE id = ?")
        .run("source-1");

      const source = await catalog.getSource("source-1");

      expect(source?.inspection.classes[0]?.className).toBe("com.example.SmokeTest");
      expect(source?.inspection.warnings).toContainEqual(
        expect.objectContaining({ code: "LEGACY_INSPECTION_RECONSTRUCTED" }),
      );
    } finally {
      handle.close();
    }
  });

  it("reserves only eligible runner capacity and persists the scheduling attempt", async () => {
    const { handle, runners, batches } = await fixture();
    try {
      await runners.register({
        id: "runner-scheduling",
        bootstrapTokenHash: "bootstrap-scheduling",
        credentialHash: "credential-scheduling",
        name: "scheduler-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java"],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await runners.heartbeat({
        runnerId: "runner-scheduling",
        labels: ["java", "testng"],
        maxConcurrency: 1,
        busySlots: 0,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 20,
          memoryUtilizationPercent: 30,
          loadAverage1m: 0.5,
          logicalCpuCount: 2,
          observedAt: "2026-08-09T00:01:00.000Z",
        },
        recordedAt: "2026-08-09T00:01:00.000Z",
      });
      await batches.create({
        id: "batch-1",
        suiteId: "suite-snapshot",
        suiteName: "Smoke",
        suiteVersion: 3,
        retryLimit: 2,
        environmentVariables: [{ name: "TEST_ENV", value: "staging" }],
        runnerIds: ["runner-scheduling"],
        runs: [
          {
            id: "run-1",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "SmokeTest",
            className: "com.example.SmokeTest",
          },
        ],
        createdAt: "2026-08-09T00:01:00.000Z",
      });
      const thresholds = {
        maximumCpuUtilizationPercent: 80,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      };
      const snapshot = await batches.getSchedulingSnapshot("batch-1", "2026-08-09T00:00:30.000Z");
      const plan = scheduleExecutionRuns({
        runs: snapshot!.queuedRuns,
        candidates: snapshot!.candidates,
        thresholds,
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-1",
        decisions: plan.decisions.map((decision) => ({ ...decision, attemptId: "attempt-1" })),
        thresholds,
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:01:01.000Z",
      });

      const batch = await batches.get("batch-1");
      expect(batch).toMatchObject({ status: "scheduled", queuedRuns: 0, assignedRuns: 1 });
      expect(batch?.runs[0]).toMatchObject({
        status: "assigned",
        assignedRunnerId: "runner-scheduling",
        attemptCount: 1,
      });
      expect(batch?.attempts[0]).toMatchObject({ id: "attempt-1", attemptNumber: 1 });
    } finally {
      handle.close();
    }
  });

  it("retries queued batches when a selected runner reports fresh metrics", async () => {
    const { handle, suites, runners, batches } = await fixture();
    try {
      await suites.create({ id: "suite-dynamic", name: "Dynamic", createdAt: timestamp });
      await suites.addCases({
        suiteId: "suite-dynamic",
        items: [{ id: "suite-item-dynamic", caseDefinitionId: "case-1" }],
        updatedAt: timestamp,
      });
      await runners.register({
        id: "runner-dynamic",
        bootstrapTokenHash: "bootstrap-dynamic",
        credentialHash: "credential-dynamic",
        name: "dynamic-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["testng"],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: "2026-08-09T00:01:00.000Z",
      });
      let nextId = 0;
      const scheduler = new RunBatchSchedulingService(
        batches,
        suites,
        runners,
        { now: () => new Date("2026-08-09T00:01:00.000Z") },
        { next: () => `dynamic-${++nextId}` },
        {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        45,
      );
      const queued = await scheduler.create({
        suiteId: "suite-dynamic",
        runnerIds: ["runner-dynamic"],
        retryLimit: 1,
        environmentVariables: [],
      });
      expect(queued.status).toBe("queued");

      await runners.heartbeat({
        runnerId: "runner-dynamic",
        labels: ["testng"],
        maxConcurrency: 1,
        busySlots: 0,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 15,
          memoryUtilizationPercent: 25,
          loadAverage1m: 0.25,
          logicalCpuCount: 2,
          observedAt: "2026-08-09T00:01:00.000Z",
        },
        recordedAt: "2026-08-09T00:01:00.000Z",
      });
      expect(await scheduler.scheduleForRunner("runner-dynamic")).toBe(1);
      expect(await scheduler.get(queued.id)).toMatchObject({
        status: "scheduled",
        assignedRuns: 1,
      });
    } finally {
      handle.close();
    }
  });
});

const timestamp = "2026-08-09T00:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-management-"));
  temporaryDirectories.push(directory);
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  const catalog = new SqliteCaseCatalogRepository(handle);
  await catalog.importCatalog({
    sourceId: "source-1",
    objectKey: "jars/aa/source.jar",
    displayName: "source",
    importedAt: timestamp,
    inspection: {
      schemaVersion: 1,
      fileName: "source.jar",
      sha256: "a".repeat(64),
      sizeBytes: 128,
      classFileCount: 1,
      testClassCount: 1,
      testMethodCount: 1,
      hasRootTestNgXml: false,
      discoveryMode: "bytecode-annotations",
      warnings: [],
      classes: [
        {
          className: "com.example.SmokeTest",
          packageName: "com.example",
          simpleName: "SmokeTest",
          enabled: true,
          classLevelTest: false,
          groups: ["smoke"],
          methods: [
            {
              methodName: "smoke",
              descriptor: "()V",
              enabled: true,
              annotationSource: "method",
              groups: ["smoke"],
              dependsOnMethods: [],
              dependsOnGroups: [],
            },
          ],
        },
      ],
    },
    cases: [
      {
        caseDefinitionId: "case-1",
        caseVersionId: "version-1",
        candidate: {
          className: "com.example.SmokeTest",
          packageName: "com.example",
          simpleName: "SmokeTest",
          enabled: true,
          classLevelTest: false,
          groups: ["smoke"],
          methods: [
            {
              methodName: "smoke",
              descriptor: "()V",
              enabled: true,
              annotationSource: "method",
              groups: ["smoke"],
              dependsOnMethods: [],
              dependsOnGroups: [],
            },
          ],
        },
        methods: [{ methodId: "method-1", methodIndex: 0 }],
      },
    ],
  });
  return {
    handle,
    catalog,
    suites: new SqliteCaseSuiteRepository(handle),
    runners: new SqliteRunnerRepository(handle),
    batches: new SqliteRunBatchRepository(handle),
  };
}
