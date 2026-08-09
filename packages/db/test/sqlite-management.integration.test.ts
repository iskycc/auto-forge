import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { SqliteExecutionControlRepository } from "../src/sqlite-execution-control";
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
        capabilities: [],
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
          capabilities: [],
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
        capabilities: [],
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
        capabilities: [],
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
        capabilities: [],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await runners.heartbeat({
        runnerId: "runner-scheduling",
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1"],
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
        decisions: plan.decisions.map((decision) => ({
          ...decision,
          attemptId: "attempt-1",
          assignmentId: "assignment-1",
        })),
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
        capabilities: ["executor:testng-v1"],
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
        capabilities: [],
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
      expect(await scheduler.scheduleForRunner("runner-dynamic")).toBe(0);
      await runners.heartbeat({
        runnerId: "runner-dynamic",
        labels: ["testng"],
        capabilities: ["executor:testng-v1"],
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

  it("claims, renews, completes and deduplicates an assignment atomically", async () => {
    const { handle, runners, batches, executions } = await fixture();
    try {
      await runners.register({
        id: "runner-control",
        bootstrapTokenHash: "bootstrap-control",
        credentialHash: "credential-control",
        name: "control-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1"],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await runners.heartbeat({
        runnerId: "runner-control",
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1"],
        maxConcurrency: 1,
        busySlots: 0,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 10,
          memoryUtilizationPercent: 20,
          loadAverage1m: 0.1,
          logicalCpuCount: 2,
          observedAt: "2026-08-09T00:01:00.000Z",
        },
        recordedAt: "2026-08-09T00:01:00.000Z",
      });
      await batches.create({
        id: "batch-control",
        suiteId: "suite-snapshot",
        suiteName: "Control",
        suiteVersion: 1,
        retryLimit: 1,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-control",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Control",
            className: "com.example.SmokeTest",
          },
        ],
        createdAt: "2026-08-09T00:01:00.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-control",
        decisions: [
          {
            executionRunId: "run-control",
            runnerId: "runner-control",
            score: 1,
            attemptId: "attempt-control",
            assignmentId: "assignment-control",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:01:01.000Z",
      });

      const claimInput = {
        runnerId: "runner-control",
        requestId: "claim-control",
        availableSlots: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1"],
        leaseSeeds: [
          {
            id: "lease-control",
            eventId: "event-claim-control",
            tokenHash: "lease-token-hash",
            tokenEncrypted: "encrypted-lease-token",
          },
        ],
        now: "2026-08-09T00:01:02.000Z",
        leaseExpiresAt: "2026-08-09T00:01:47.000Z",
      };
      const claimed = await executions.claim(claimInput);
      expect(claimed).toHaveLength(1);
      await expect(
        executions.resolveAttemptInput({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          inputId: "source-1",
          leaseTokenHash: "lease-token-hash",
          now: "2026-08-09T00:01:03.000Z",
        }),
      ).resolves.toEqual({
        objectKey: "jars/aa/source.jar",
        sizeBytes: 128,
        sha256: "a".repeat(64),
      });
      await expect(
        executions.resolveAttemptInput({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          inputId: "source-1",
          leaseTokenHash: "wrong-token-hash",
          now: "2026-08-09T00:01:03.000Z",
        }),
      ).rejects.toMatchObject({ code: "ATTEMPT_INPUT_FORBIDDEN" });
      await expect(executions.claim(claimInput)).resolves.toEqual(claimed);
      await expect(
        executions.reconcile({
          runnerId: "runner-control",
          request: {
            schemaVersion: 1,
            requestId: "reconcile-control",
            attempts: [{ attemptId: "attempt-control", localState: "running" }],
          },
          now: "2026-08-09T00:01:05.000Z",
        }),
      ).resolves.toMatchObject({ decisions: [{ action: "continue" }] });

      const renewed = await executions.renewLease({
        runnerId: "runner-control",
        leaseId: "lease-control",
        tokenHash: "lease-token-hash",
        expectedVersion: 1,
        now: "2026-08-09T00:01:10.000Z",
        expiresAt: "2026-08-09T00:01:55.000Z",
      });
      expect(renewed).toMatchObject({ leaseVersion: 2, instruction: "continue" });

      const completion = await executions.completeAttempt({
        runnerId: "runner-control",
        attemptId: "attempt-control",
        completionId: "completion-control",
        leaseTokenHash: "lease-token-hash",
        resultDigest: "result-digest",
        result: {
          status: "failed",
          resultCode: "TEST_ASSERTION_FAILED",
          summary: "assertion failed",
          durationMs: 1_000,
          artifacts: [],
        },
        eventId: "event-complete-control",
        acceptedAt: "2026-08-09T00:01:20.000Z",
      });
      expect(completion).toMatchObject({ disposition: "accepted", retryScheduled: true });
      await expect(
        executions.completeAttempt({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          completionId: "completion-control",
          leaseTokenHash: "lease-token-hash",
          resultDigest: "result-digest",
          result: {
            status: "failed",
            resultCode: "TEST_ASSERTION_FAILED",
            summary: "assertion failed",
            durationMs: 1_000,
            artifacts: [],
          },
          eventId: "unused-event",
          acceptedAt: "2026-08-09T00:01:21.000Z",
        }),
      ).resolves.toMatchObject({ disposition: "duplicate" });
      expect(await batches.get("batch-control")).toMatchObject({ status: "queued", queuedRuns: 1 });

      await batches.reserveAssignments({
        batchId: "batch-control",
        decisions: [
          {
            executionRunId: "run-control",
            runnerId: "runner-control",
            score: 1,
            attemptId: "attempt-control-2",
            assignmentId: "assignment-control-2",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:01:21.000Z",
      });
      await executions.claim({
        ...claimInput,
        requestId: "claim-control-2",
        leaseSeeds: [
          {
            id: "lease-control-2",
            eventId: "event-claim-control-2",
            tokenHash: "lease-token-hash-2",
            tokenEncrypted: "encrypted-lease-token-2",
          },
        ],
        now: "2026-08-09T00:01:22.000Z",
        leaseExpiresAt: "2026-08-09T00:02:07.000Z",
      });
      await executions.cancelRun({
        runId: "run-control",
        actorId: "administrator",
        reason: "operator cancellation",
        eventId: "event-cancel-control",
        requestedAt: "2026-08-09T00:01:23.000Z",
      });
      await expect(
        executions.renewLease({
          runnerId: "runner-control",
          leaseId: "lease-control-2",
          tokenHash: "lease-token-hash-2",
          expectedVersion: 1,
          now: "2026-08-09T00:01:24.000Z",
          expiresAt: "2026-08-09T00:02:09.000Z",
        }),
      ).resolves.toMatchObject({ instruction: "cancel" });
      await executions.completeAttempt({
        runnerId: "runner-control",
        attemptId: "attempt-control-2",
        completionId: "completion-control-2",
        leaseTokenHash: "lease-token-hash-2",
        resultDigest: "result-digest-2",
        result: {
          status: "succeeded",
          resultCode: "PASSED",
          summary: "late success after cancellation",
          durationMs: 500,
          artifacts: [],
        },
        eventId: "event-complete-control-2",
        acceptedAt: "2026-08-09T00:01:25.000Z",
      });
      expect(await batches.get("batch-control")).toMatchObject({
        status: "cancelled",
        cancelledRuns: 1,
      });

      await batches.create({
        id: "batch-expiry-control",
        suiteId: "suite-1",
        suiteName: "Expiry suite",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-expiry-control",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Expiry",
            className: "com.example.ExpiryTest",
          },
        ],
        createdAt: "2026-08-09T00:02:00.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-expiry-control",
        decisions: [
          {
            executionRunId: "run-expiry-control",
            runnerId: "runner-control",
            score: 1,
            attemptId: "attempt-expiry-control",
            assignmentId: "assignment-expiry-control",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:02:01.000Z",
      });
      await executions.claim({
        ...claimInput,
        requestId: "claim-expiry-control",
        leaseSeeds: [
          {
            id: "lease-expiry-control",
            eventId: "event-claim-expiry-control",
            tokenHash: "lease-expiry-token-hash",
            tokenEncrypted: "encrypted-expiry-lease-token",
          },
        ],
        now: "2026-08-09T00:02:02.000Z",
        leaseExpiresAt: "2026-08-09T00:02:47.000Z",
      });
      await expect(
        executions.recoverExpired({
          now: "2026-08-09T00:02:48.000Z",
          eventIds: ["event-expire-control"],
          limit: 1,
        }),
      ).resolves.toBe(1);
      expect(await batches.get("batch-expiry-control")).toMatchObject({
        status: "failed",
        timedOutRuns: 1,
      });
      const lateCompletion = await executions.completeAttempt({
        runnerId: "runner-control",
        attemptId: "attempt-expiry-control",
        completionId: "completion-expiry-control",
        leaseTokenHash: "lease-expiry-token-hash",
        resultDigest: "late-result-digest",
        result: {
          status: "succeeded",
          resultCode: "PASSED",
          summary: "late success after lease expiry",
          durationMs: 500,
          artifacts: [],
        },
        eventId: "unused-late-event",
        acceptedAt: "2026-08-09T00:02:49.000Z",
      });
      expect(lateCompletion).toMatchObject({ disposition: "late", retryScheduled: false });
      expect(await batches.get("batch-expiry-control")).toMatchObject({
        status: "failed",
        timedOutRuns: 1,
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
    executions: new SqliteExecutionControlRepository(handle),
  };
}
