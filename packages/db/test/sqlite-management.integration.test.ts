import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { createAttemptLogStore } from "../src/attempt-log-store";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { SqliteExecutionControlRepository } from "../src/sqlite-execution-control";
import { SqliteRoundRecoveryRepository } from "../src/sqlite-round-recovery";
import { SqliteRunnerRepository } from "../src/sqlite-runner";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { defaultCaseSuiteExecutionPolicy, scheduleExecutionRuns } from "@autoforge/domain";
import { RunBatchSchedulingService, type JarObjectStorePort } from "@autoforge/application";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite management repositories", () => {
  it("persists, deduplicates, cancels and retries background JAR imports", async () => {
    const { handle, catalog } = await fixture();
    try {
      const createdAt = "2026-08-09T00:10:00.000Z";
      const job = {
        id: "import-job-1",
        projectId: "00000000-0000-7000-8000-000000000001",
        fileName: "large-tests.jar",
        sha256: "b".repeat(64),
        sizeBytes: 10_000,
        status: "queued" as const,
        progressPercent: 0,
        requestedBy: "user-admin",
        createdAt,
        updatedAt: createdAt,
      };
      const dispatchJob = {
        schemaVersion: 1 as const,
        messageId: "import-message-1",
        runId: job.id,
        attempt: 1,
        createdAt,
        priority: 0,
        deduplicationKey: "jar-import:large-tests",
        kind: "jar-import" as const,
        payload: { jobId: job.id },
      };
      await expect(
        catalog.createJarImportJob({
          job,
          objectKey: `jars/${job.sha256}.jar`,
          idempotencyKey: "large-tests",
          dispatchJob,
        }),
      ).resolves.toMatchObject({ id: job.id, status: "queued" });
      await expect(
        catalog.createJarImportJob({
          job: { ...job, id: "import-job-duplicate" },
          objectKey: `jars/${job.sha256}.jar`,
          idempotencyKey: "large-tests",
          dispatchJob: { ...dispatchJob, messageId: "import-message-duplicate" },
        }),
      ).resolves.toMatchObject({ id: job.id });
      expect(
        handle.client
          .prepare("SELECT COUNT(*) AS count FROM queue_jobs WHERE kind = 'jar-import'")
          .get(),
      ).toEqual({ count: 1 });
      await expect(
        catalog.requestJarImportCancellation({ jobId: job.id, updatedAt: createdAt }),
      ).resolves.toMatchObject({ status: "cancelled" });
      await expect(
        catalog.retryJarImportJob({
          jobId: job.id,
          dispatchJob: {
            ...dispatchJob,
            messageId: "import-message-retry",
            deduplicationKey: "jar-import:large-tests:retry",
          },
          updatedAt: "2026-08-09T00:11:00.000Z",
        }),
      ).resolves.toMatchObject({ status: "queued", progressPercent: 0 });
      await expect(
        catalog.retryJarImportJob({
          jobId: job.id,
          dispatchJob: {
            ...dispatchJob,
            messageId: "import-message-retry-race",
            deduplicationKey: "jar-import:large-tests:retry-race",
          },
          updatedAt: "2026-08-09T00:11:00.500Z",
        }),
      ).resolves.toMatchObject({ status: "queued", progressPercent: 0 });
      expect(
        handle.client
          .prepare("SELECT COUNT(*) AS count FROM queue_jobs WHERE kind = 'jar-import'")
          .get(),
      ).toEqual({ count: 2 });
      await expect(
        catalog.claimJarImportJob({ jobId: job.id, startedAt: "2026-08-09T00:11:01.000Z" }),
      ).resolves.toMatchObject({
        job: { status: "running", progressPercent: 5 },
        objectKey: `jars/${job.sha256}.jar`,
      });
      await expect(
        catalog.requestJarImportCancellation({
          jobId: job.id,
          updatedAt: "2026-08-09T00:11:02.000Z",
        }),
      ).resolves.toMatchObject({ status: "cancel_requested" });
    } finally {
      handle.close();
    }
  });

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
        versionId: "suite-version-2",
        updatedAt: timestamp,
      });
      expect(withCase).toMatchObject({ caseCount: 1, version: 2 });
      expect((await suites.get("suite-1"))?.items[0]?.caseDefinition.className).toBe(
        "com.example.SmokeTest",
      );

      const empty = await suites.removeCases({
        suiteId: "suite-1",
        caseDefinitionIds: ["case-1"],
        versionId: "suite-version-3",
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

  it("recovers an existing Runner identity without changing its logical id", async () => {
    const { handle, runners } = await fixture();
    try {
      await runners.register({
        id: "runner-reinstall",
        bootstrapTokenHash: "bootstrap-original",
        credentialHash: "credential-original",
        name: "runner-before",
        os: "linux",
        architecture: "amd64",
        agentVersion: "1.2.6",
        protocolVersion: 1,
        labels: ["before"],
        capabilities: ["executor:testng-v1"],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: timestamp,
      });

      const recovered = await runners.register({
        id: "runner-reinstall",
        recoverExistingIdentity: true,
        bootstrapTokenHash: "bootstrap-reinstall",
        credentialHash: "credential-reinstalled",
        name: "runner-after",
        os: "linux",
        architecture: "amd64",
        agentVersion: "1.2.7",
        protocolVersion: 1,
        labels: ["after"],
        capabilities: ["executor:testng-v1", "runtime:project-assets-v1"],
        maxConcurrency: 4,
        terminalEnabled: true,
        recordedAt: "2026-08-09T00:01:00.000Z",
      });

      expect(recovered).toMatchObject({
        id: "runner-reinstall",
        name: "runner-after",
        credentialVersion: 2,
        terminalEnabled: true,
        maxConcurrency: 4,
      });
      expect(await runners.findByCredentialHash("credential-original", timestamp)).toBeNull();
      expect((await runners.findByCredentialHash("credential-reinstalled", timestamp))?.id).toBe(
        "runner-reinstall",
      );
    } finally {
      handle.close();
    }
  });

  it("rotates, revokes and deregisters runner credentials", async () => {
    const { handle, runners, batches, executions } = await fixture();
    try {
      await runners.register({
        id: "runner-rotate",
        bootstrapTokenHash: "bootstrap-rotate",
        credentialHash: "credential-v1",
        name: "rotating-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21", "testng:7.11.0"],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      expect(
        (await runners.findByCredentialHash("credential-v1", "2026-08-09T00:00:30.000Z"))?.id,
      ).toBe("runner-rotate");

      const requested = await runners.requestCredentialRotation({
        runnerId: "runner-rotate",
        requestedAt: "2026-08-09T00:00:45.000Z",
      });
      expect(requested.credentialRotationRequestedAt).toBe("2026-08-09T00:00:45.000Z");

      const rotated = await runners.rotateCredential({
        runnerId: "runner-rotate",
        credentialHash: "credential-v2",
        previousCredentialValidUntil: "2026-08-09T00:15:00.000Z",
        rotatedAt: "2026-08-09T00:01:00.000Z",
      });
      expect(rotated.credentialVersion).toBe(2);
      expect(rotated.credentialRotationRequestedAt).toBeUndefined();
      expect(
        (await runners.findByCredentialHash("credential-v1", "2026-08-09T00:10:00.000Z"))?.id,
      ).toBe("runner-rotate");
      expect(
        await runners.findByCredentialHash("credential-v1", "2026-08-09T00:16:00.000Z"),
      ).toBeNull();
      expect(
        (await runners.findByCredentialHash("credential-v2", "2026-08-09T00:16:00.000Z"))?.id,
      ).toBe("runner-rotate");

      const revoked = await runners.revokeCredential({
        runnerId: "runner-rotate",
        revokedAt: "2026-08-09T00:20:00.000Z",
      });
      expect(revoked.credentialRevokedAt).toBe("2026-08-09T00:20:00.000Z");
      expect(
        await runners.findByCredentialHash("credential-v1", "2026-08-09T00:10:00.000Z"),
      ).toBeNull();

      await runners.heartbeat({
        runnerId: "runner-rotate",
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21", "testng:7.11.0"],
        maxConcurrency: 1,
        busySlots: 0,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 10,
          memoryUtilizationPercent: 20,
          loadAverage1m: 0.1,
          logicalCpuCount: 2,
          observedAt: "2026-08-09T00:20:30.000Z",
        },
        recordedAt: "2026-08-09T00:20:30.000Z",
      });
      await batches.create({
        id: "batch-rotate",
        suiteId: "suite-snapshot",
        suiteName: "Rotate",
        suiteVersion: 1,
        retryLimit: 1,
        environmentVariables: [],
        runnerIds: ["runner-rotate"],
        runs: [
          {
            id: "run-rotate",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Rotate",
            className: "com.example.SmokeTest",
          },
        ],
        createdAt: "2026-08-09T00:20:31.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-rotate",
        decisions: [
          {
            executionRunId: "run-rotate",
            runnerId: "runner-rotate",
            score: 1,
            attemptId: "attempt-rotate",
            assignmentId: "assignment-rotate",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:20:00.000Z",
        metricsFreshAfter: "2026-08-09T00:20:00.000Z",
        scheduledAt: "2026-08-09T00:20:32.000Z",
      });
      const claimed = await executions.claim({
        runnerId: "runner-rotate",
        requestId: "claim-rotate",
        availableSlots: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21", "testng:7.11.0"],
        leaseSeeds: [
          {
            id: "lease-rotate",
            eventId: "event-claim-rotate",
            tokenHash: "lease-token-rotate",
            tokenEncrypted: "encrypted-lease-token-rotate",
          },
        ],
        now: "2026-08-09T00:20:33.000Z",
        leaseExpiresAt: "2026-08-09T00:21:18.000Z",
      });
      expect(claimed).toHaveLength(1);

      const deregistered = await runners.deregister({
        runnerId: "runner-rotate",
        deregisteredAt: "2026-08-09T00:21:00.000Z",
      });
      expect(deregistered.deregisteredAt).toBe("2026-08-09T00:21:00.000Z");
      expect(deregistered.state).toBe("disabled");
      const lease = handle.client
        .prepare("SELECT expires_at, status FROM assignment_leases WHERE id = ?")
        .get("lease-rotate") as { expires_at: string; status: string };
      expect(lease.expires_at).toBe("2026-08-09T00:21:00.000Z");

      const recovered = await executions.recoverExpired({
        now: "2026-08-09T00:21:00.001Z",
        eventIds: ["event-recover-rotate"],
        limit: 10,
      });
      expect(recovered).toEqual([
        {
          attemptId: "attempt-rotate",
          batchId: "batch-rotate",
          executionRunId: "run-rotate",
          runnerId: "runner-rotate",
          reason: "lease_expired",
          retryScheduled: true,
        },
      ]);
      const leaseAfter = handle.client
        .prepare("SELECT status FROM assignment_leases WHERE id = ?")
        .get("lease-rotate") as { status: string };
      expect(leaseAfter.status).toBe("expired");
      const run = handle.client
        .prepare("SELECT status FROM execution_runs WHERE id = ?")
        .get("run-rotate") as { status: string };
      expect(run.status).toBe("queued");
    } finally {
      handle.close();
    }
  });

  it("purges a deregistered runner and hides it from listings", async () => {
    const { handle, runners } = await fixture();
    try {
      await runners.register({
        id: "runner-purge",
        bootstrapTokenHash: "bootstrap-purge",
        credentialHash: "credential-purge",
        name: "purge-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java"],
        capabilities: ["executor:testng-v1"],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      expect((await runners.list("2026-08-08T23:59:00.000Z", 100)).map((row) => row.id)).toContain(
        "runner-purge",
      );

      await runners.deregister({
        runnerId: "runner-purge",
        deregisteredAt: "2026-08-09T00:10:00.000Z",
      });
      const purged = await runners.purge({
        runnerId: "runner-purge",
        purgedAt: "2026-08-09T00:11:00.000Z",
      });
      expect(purged.purgedAt).toBe("2026-08-09T00:11:00.000Z");
      expect(purged.labels).toEqual([]);
      expect(purged.capabilities).toEqual([]);

      expect(
        (await runners.list("2026-08-08T23:59:00.000Z", 100)).map((row) => row.id),
      ).not.toContain("runner-purge");
      expect(
        await runners.findByCredentialHash("credential-purge", "2026-08-09T00:12:00.000Z"),
      ).toBeNull();
      // get 不过滤墓碑记录，供重复清除时幂等返回。
      expect((await runners.get("runner-purge", "2026-08-09T00:12:00.000Z"))?.purgedAt).toBe(
        "2026-08-09T00:11:00.000Z",
      );
      const stored = handle.client
        .prepare("SELECT credential_hash FROM runners WHERE id = ?")
        .get("runner-purge") as { credential_hash: string };
      expect(stored.credential_hash).toBe("purged:runner-purge");

      // 同名新机器重新注册不受墓碑记录影响。
      const replacement = await runners.register({
        id: "runner-purge-replacement",
        bootstrapTokenHash: "bootstrap-purge-replacement",
        credentialHash: "credential-purge-replacement",
        name: "purge-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: [],
        capabilities: [],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: "2026-08-09T00:13:00.000Z",
      });
      expect(replacement?.id).toBe("runner-purge-replacement");
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
    const { handle, catalog, runners, batches } = await fixture();
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
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
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
      await catalog.importCatalog({
        sourceId: "source-after-batch",
        objectKey: "jars/source-after-batch.jar",
        displayName: "Source after batch creation",
        importedAt: "2026-08-09T00:01:00.500Z",
        inspection: {
          schemaVersion: 1,
          fileName: "source-after-batch.jar",
          sha256: "d".repeat(64),
          sizeBytes: 256,
          classFileCount: 0,
          testClassCount: 0,
          testMethodCount: 0,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [],
        },
        cases: [],
      });
      handle.client
        .prepare("UPDATE case_definitions SET source_id = ? WHERE id = ?")
        .run("source-after-batch", "case-1");
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
      expect(batch).toMatchObject({
        status: "scheduled",
        queuedRuns: 0,
        assignedRuns: 1,
        version: 2,
        statusHistory: [
          { toStatus: "queued", batchVersion: 1 },
          { fromStatus: "queued", toStatus: "scheduled", batchVersion: 2 },
        ],
      });
      expect(batch?.runs[0]).toMatchObject({
        status: "assigned",
        assignedRunnerId: "runner-scheduling",
        attemptCount: 1,
      });
      expect(batch?.attempts[0]).toMatchObject({ id: "attempt-1", attemptNumber: 1 });
      const assignment = handle.client
        .prepare("SELECT execution_spec_json FROM assignments WHERE id = ?")
        .get("assignment-1") as { execution_spec_json: string };
      const executionSpec = JSON.parse(assignment.execution_spec_json) as {
        inputs: Array<{ inputId: string }>;
      };
      expect(executionSpec.inputs[0]?.inputId).toBe("source-1");

      await batches.create({
        id: "batch-project-b",
        projectId: "project-b",
        suiteId: "suite-project-b",
        suiteName: "Project B suite",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: ["runner-scheduling"],
        policy: {
          executor: "testng",
          concurrency: 1,
          projectVersionId: "version-project-b",
          runnerLabels: [],
          artifactPatterns: [],
        },
        runs: [
          {
            id: "run-project-b",
            caseDefinitionId: "case-project-b",
            caseVersion: 1,
            displayName: "Project B case",
            className: "com.example.ProjectBTest",
          },
        ],
        createdAt: "2026-08-09T00:02:00.000Z",
      });
      await expect(batches.list(10, ["project-b"])).resolves.toMatchObject([
        { id: "batch-project-b", projectId: "project-b" },
      ]);
      await expect(batches.list(10, ["project-b"], "version-project-b")).resolves.toMatchObject([
        { id: "batch-project-b", policy: { projectVersionId: "version-project-b" } },
      ]);
      await expect(
        batches.listPage({
          projectIds: ["project-b"],
          projectVersionId: "version-project-b",
          caseDefinitionId: "case-project-b",
          suiteId: "suite-project-b",
          createdAfter: "2026-08-09T00:01:30.000Z",
          createdBefore: "2026-08-09T00:02:30.000Z",
          limit: 10,
        }),
      ).resolves.toMatchObject({ items: [{ id: "batch-project-b" }] });
      const firstPage = await batches.listPage({ limit: 1 });
      expect(firstPage.items).toMatchObject([{ id: "batch-project-b" }]);
      expect(firstPage.nextCursor).toBeTruthy();
      await expect(
        batches.listPage({
          cursor: firstPage.nextCursor!,
          runnerId: "runner-scheduling",
          limit: 1,
        }),
      ).resolves.toMatchObject({ items: [{ id: "batch-1" }] });
      await expect(batches.get("batch-1", ["project-b"])).resolves.toBeNull();
      await expect(executionsProjectId(handle, "attempt-1")).resolves.toBe(
        "00000000-0000-7000-8000-000000000001",
      );
    } finally {
      handle.close();
    }
  });

  it("omits artifact rules from assignment specs when artifact collection is disabled", async () => {
    const { handle, runners } = await fixture();
    try {
      const disabledBatches = new SqliteRunBatchRepository(handle);
      await runners.register({
        id: "runner-artifacts-off",
        bootstrapTokenHash: "bootstrap-artifacts-off",
        credentialHash: "credential-artifacts-off",
        name: "artifacts-off-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java"],
        capabilities: [],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: "2026-08-09T00:03:00.000Z",
      });
      await runners.heartbeat({
        runnerId: "runner-artifacts-off",
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 1,
        busySlots: 0,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 20,
          memoryUtilizationPercent: 30,
          loadAverage1m: 0.5,
          logicalCpuCount: 2,
          observedAt: "2026-08-09T00:03:00.000Z",
        },
        recordedAt: "2026-08-09T00:03:00.000Z",
      });
      const createdBatch = await disabledBatches.create({
        id: "batch-artifacts-off",
        suiteId: "suite-artifacts-off",
        suiteName: "Artifacts off",
        suiteVersion: 1,
        retryLimit: 0,
        policy: {
          executor: "testng",
          concurrency: 1,
          runnerLabels: [],
          artifactPatterns: [],
          retryConcurrencyRules: [],
        },
        environmentVariables: [],
        runnerIds: ["runner-artifacts-off"],
        runs: [
          {
            id: "run-artifacts-off",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "SmokeTest",
            className: "com.example.SmokeTest",
          },
        ],
        createdAt: "2026-08-09T00:03:00.000Z",
      });
      expect(createdBatch.sequenceNumber).toBe(1);
      const thresholds = {
        maximumCpuUtilizationPercent: 80,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      };
      const snapshot = await disabledBatches.getSchedulingSnapshot(
        "batch-artifacts-off",
        "2026-08-09T00:02:30.000Z",
      );
      const plan = scheduleExecutionRuns({
        runs: snapshot!.queuedRuns,
        candidates: snapshot!.candidates,
        thresholds,
        metricsFreshAfter: "2026-08-09T00:02:30.000Z",
      });
      await disabledBatches.reserveAssignments({
        batchId: "batch-artifacts-off",
        decisions: plan.decisions.map((decision) => ({
          ...decision,
          attemptId: "attempt-artifacts-off",
          assignmentId: "assignment-artifacts-off",
        })),
        thresholds,
        offlineBefore: "2026-08-09T00:02:30.000Z",
        metricsFreshAfter: "2026-08-09T00:02:30.000Z",
        scheduledAt: "2026-08-09T00:03:01.000Z",
      });
      const assignment = handle.client
        .prepare("SELECT execution_spec_json FROM assignments WHERE id = ?")
        .get("assignment-artifacts-off") as { execution_spec_json: string };
      const spec = JSON.parse(assignment.execution_spec_json) as { artifactRules: unknown[] };
      // 平台开关在创建批次时固化为空规则，领取阶段不得用进程启动配置覆盖快照。
      expect(spec.artifactRules).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("retries queued batches when a selected runner reports fresh metrics", async () => {
    const { handle, catalog, suites, runners, batches } = await fixture();
    try {
      await suites.create({
        id: "suite-dynamic",
        name: "Dynamic",
        policy: {
          ...defaultCaseSuiteExecutionPolicy,
          retryLimit: 1,
          projectVersionId: "project-version-1",
          runnerIds: ["runner-dynamic"],
        },
        createdAt: timestamp,
      });
      await suites.addCases({
        suiteId: "suite-dynamic",
        items: [{ id: "suite-item-dynamic", caseDefinitionId: "case-1" }],
        versionId: "suite-version-dynamic",
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
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
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
        {
          catalog,
          objectStore: { exists: async () => true } as unknown as JarObjectStorePort,
        },
      );
      const queued = await scheduler.create({ suiteId: "suite-dynamic" });
      expect(queued).toMatchObject({
        status: "queued",
        environmentVariables: [],
        secretBindings: [],
      });
      await runners.heartbeat({
        runnerId: "runner-dynamic",
        labels: ["java", "testng"],
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
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
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
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await runners.heartbeat({
        runnerId: "runner-control",
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
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
        id: "00000000-0000-4000-8000-0000000c0001",
        suiteId: "suite-snapshot",
        suiteName: "Control",
        suiteVersion: 1,
        retryLimit: 1,
        environmentVariables: [],
        secretBindings: [],
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
        batchId: "00000000-0000-4000-8000-0000000c0001",
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
      handle.client
        .prepare(
          `INSERT INTO case_sources (
             id, display_name, original_file_name, object_key, sha256, size_bytes,
             class_count, method_count, status, warnings_json, inspection_json,
             authoritative, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'ready', '[]', '{}', 0, ?)`,
        )
        .run(
          "dependency-1",
          "Support dependency",
          "support.jar",
          "jars/bb/support.jar",
          "b".repeat(64),
          64,
          "2026-08-09T00:01:01.000Z",
        );
      const assignmentSnapshot = handle.client
        .prepare("SELECT execution_spec_json FROM assignments WHERE id = ?")
        .get("assignment-control") as { execution_spec_json: string };
      const executionSpec = JSON.parse(assignmentSnapshot.execution_spec_json) as {
        inputs: Array<Record<string, unknown>>;
      };
      executionSpec.inputs.push({
        inputId: "dependency-1",
        kind: "dependency-jar",
        targetPath: "inputs/lib/support.jar",
        mediaType: "application/java-archive",
        sizeBytes: 64,
        sha256: "b".repeat(64),
      });
      handle.client
        .prepare("UPDATE assignments SET execution_spec_json = ? WHERE id = ?")
        .run(JSON.stringify(executionSpec), "assignment-control");

      const claimInput = {
        runnerId: "runner-control",
        requestId: "claim-control",
        availableSlots: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
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
      expect(claimed[0]?.assignment.executionSpec).toMatchObject({
        environment: [],
        secretReferences: [],
      });
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
          inputId: "dependency-1",
          leaseTokenHash: "lease-token-hash",
          now: "2026-08-09T00:01:03.000Z",
        }),
      ).resolves.toEqual({
        objectKey: "jars/bb/support.jar",
        sizeBytes: 64,
        sha256: "b".repeat(64),
      });
      await expect(
        executions.resolveAttemptInput({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          inputId: "undeclared-source",
          leaseTokenHash: "lease-token-hash",
          now: "2026-08-09T00:01:03.000Z",
        }),
      ).rejects.toMatchObject({ code: "ATTEMPT_INPUT_FORBIDDEN" });
      handle.client
        .prepare("UPDATE case_sources SET sha256 = ? WHERE id = ?")
        .run("c".repeat(64), "dependency-1");
      await expect(
        executions.resolveAttemptInput({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          inputId: "dependency-1",
          leaseTokenHash: "lease-token-hash",
          now: "2026-08-09T00:01:03.000Z",
        }),
      ).rejects.toMatchObject({ code: "ATTEMPT_INPUT_INVALID" });
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

      const gap = await executions.appendLogChunks({
        runnerId: "runner-control",
        attemptId: "attempt-control",
        leaseTokenHash: "lease-token-hash",
        chunks: [
          {
            stream: "stdout",
            sequence: 1,
            content: "second",
            recordedAt: "2026-08-09T00:01:03.000Z",
          },
        ],
        receivedAt: "2026-08-09T00:01:03.100Z",
      });
      expect(gap.acknowledgedSequence.stdout).toBe(-1);

      const contiguous = await executions.appendLogChunks({
        runnerId: "runner-control",
        attemptId: "attempt-control",
        leaseTokenHash: "lease-token-hash",
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "first",
            recordedAt: "2026-08-09T00:01:02.500Z",
          },
          {
            stream: "stdout",
            sequence: 1,
            content: "second",
            recordedAt: "2026-08-09T00:01:03.000Z",
          },
        ],
        receivedAt: "2026-08-09T00:01:03.200Z",
      });
      expect(contiguous.acknowledgedSequence.stdout).toBe(1);
      await expect(
        executions.appendLogChunks({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          leaseTokenHash: "lease-token-hash",
          chunks: [
            {
              stream: "stdout",
              sequence: 1,
              content: "conflicting",
              recordedAt: "2026-08-09T00:01:03.000Z",
            },
          ],
          receivedAt: "2026-08-09T00:01:03.300Z",
        }),
      ).rejects.toMatchObject({ code: "LOG_CHUNK_CONFLICT" });
      await expect(
        executions.listLogChunks({
          attemptId: "attempt-control",
          stream: "stdout",
          afterSequence: -1,
          limit: 10,
        }),
      ).resolves.toMatchObject({
        acknowledgedSequence: 1,
        items: [
          { sequence: 0, content: "first" },
          { sequence: 1, content: "second" },
        ],
      });
      const artifact = {
        artifactId: "artifact-control",
        relativePath: "reports/testng-results.xml",
        mediaType: "application/xml",
        sizeBytes: 12,
        sha256: "b".repeat(64),
        required: true,
      };
      await expect(
        executions.declareArtifacts({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          leaseTokenHash: "lease-token-hash",
          artifacts: [artifact],
          declaredAt: "2026-08-09T00:01:03.400Z",
        }),
      ).resolves.toEqual([{ ...artifact, status: "declared" }]);
      await expect(
        executions.declareArtifacts({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          leaseTokenHash: "lease-token-hash",
          artifacts: [artifact],
          declaredAt: "2026-08-09T00:01:03.450Z",
        }),
      ).resolves.toEqual([{ ...artifact, status: "declared" }]);
      await expect(
        executions.declareArtifacts({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          leaseTokenHash: "lease-token-hash",
          artifacts: [{ ...artifact, sha256: "c".repeat(64) }],
          declaredAt: "2026-08-09T00:01:03.460Z",
        }),
      ).rejects.toMatchObject({ code: "ARTIFACT_DECLARATION_CONFLICT" });
      await expect(
        executions.resolveArtifactUpload({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          artifactId: artifact.artifactId,
          leaseTokenHash: "lease-token-hash",
          now: "2026-08-09T00:01:03.500Z",
        }),
      ).resolves.toMatchObject(artifact);
      await executions.markArtifactUploaded({
        attemptId: "attempt-control",
        artifactId: artifact.artifactId,
        objectKey: `artifacts/attempt-control/artifact-control/${artifact.sha256}`,
        uploadedAt: "2026-08-09T00:01:03.600Z",
      });
      await expect(executions.listArtifacts("attempt-control")).resolves.toMatchObject([
        { ...artifact, status: "uploaded" },
      ]);
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
          testNg: structuredTestNgResult("failed"),
          artifacts: [],
        },
        eventId: "event-complete-control",
        acceptedAt: "2026-08-09T00:01:20.000Z",
      });
      expect(completion).toMatchObject({ disposition: "accepted", retryScheduled: true });
      expect(
        handle.client
          .prepare(
            `SELECT actor_type, action, resource_type, resource_id, project_id, result, details_json
             FROM audit_events WHERE action = 'execution_run.retry_scheduled' AND resource_id = ?`,
          )
          .all("run-control"),
      ).toEqual([
        {
          actor_type: "system",
          action: "execution_run.retry_scheduled",
          resource_type: "execution_run",
          resource_id: "run-control",
          project_id: "00000000-0000-7000-8000-000000000001",
          result: "succeeded",
          details_json: JSON.stringify({
            attemptNumber: 1,
            resultCode: "TEST_ASSERTION_FAILED",
          }),
        },
      ]);
      expect(await batches.get("00000000-0000-4000-8000-0000000c0001")).toMatchObject({
        status: "queued",
        version: 4,
        statusHistory: [
          { toStatus: "queued", batchVersion: 1, reason: "batch.created" },
          { fromStatus: "queued", toStatus: "scheduled", batchVersion: 2 },
          { fromStatus: "scheduled", toStatus: "running", batchVersion: 3 },
          { fromStatus: "running", toStatus: "queued", batchVersion: 4 },
        ],
        attempts: [
          {
            id: "attempt-control",
            durationMs: 1_000,
            testNg: {
              failed: 1,
              suites: [{ tests: [{ classes: [{ methods: [{ name: "fails" }] }] }] }],
            },
          },
        ],
      });
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
      expect(
        handle.client
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'execution_run.retry_scheduled' AND resource_id = ?",
          )
          .get("run-control"),
      ).toEqual({ count: 1 });
      await expect(
        executions.completeAttempt({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          completionId: "completion-control-conflict",
          leaseTokenHash: "lease-token-hash",
          resultDigest: "different-result-digest",
          result: {
            status: "succeeded",
            resultCode: "PASSED",
            summary: "conflicting result",
            durationMs: 1_000,
            artifacts: [],
          },
          eventId: "event-completion-conflict",
          acceptedAt: "2026-08-09T00:01:21.500Z",
        }),
      ).rejects.toMatchObject({ code: "ATTEMPT_COMPLETION_CONFLICT" });
      expect(
        handle.client
          .prepare(
            "SELECT event_type, reason_code FROM attempt_state_events WHERE id = ? AND attempt_id = ?",
          )
          .get("event-completion-conflict", "attempt-control"),
      ).toEqual({
        event_type: "attempt.completion_conflict",
        reason_code: "ATTEMPT_COMPLETION_CONFLICT",
      });
      const firstEventPage = await executions.listAttemptEvents({
        attemptId: "attempt-control",
        limit: 2,
      });
      expect(firstEventPage).toMatchObject({
        items: [
          { eventType: "assignment.claimed", toStatus: "running" },
          { eventType: "attempt.completed", toStatus: "failed" },
        ],
        nextEventId: "event-complete-control",
      });
      await expect(
        executions.listAttemptEvents({
          attemptId: "attempt-control",
          afterEventId: firstEventPage.nextEventId!,
          limit: 2,
        }),
      ).resolves.toMatchObject({
        items: [
          {
            eventType: "attempt.completion_conflict",
            reasonCode: "ATTEMPT_COMPLETION_CONFLICT",
          },
        ],
      });
      expect(await batches.get("00000000-0000-4000-8000-0000000c0001")).toMatchObject({
        status: "queued",
        queuedRuns: 1,
      });

      await batches.reserveAssignments({
        batchId: "00000000-0000-4000-8000-0000000c0001",
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
      expect(await batches.get("00000000-0000-4000-8000-0000000c0001")).toMatchObject({
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
      ).resolves.toEqual([
        {
          attemptId: "attempt-expiry-control",
          batchId: "batch-expiry-control",
          executionRunId: "run-expiry-control",
          runnerId: "runner-control",
          reason: "lease_expired",
          retryScheduled: true,
        },
      ]);
      expect(await batches.get("batch-expiry-control")).toMatchObject({
        status: "queued",
        // 历史列表与详情“总结”一致：下一轮 attempt 尚未创建时，最新一轮超时仍可见。
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
        status: "queued",
        timedOutRuns: 1,
      });

      await batches.create({
        id: "batch-execution-timeout",
        suiteId: "suite-1",
        suiteName: "Execution timeout suite",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-execution-timeout",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Execution timeout",
            className: "com.example.ExecutionTimeoutTest",
          },
        ],
        createdAt: "2026-08-09T00:03:00.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-execution-timeout",
        decisions: [
          {
            executionRunId: "run-execution-timeout",
            runnerId: "runner-control",
            score: 1,
            attemptId: "attempt-execution-timeout",
            assignmentId: "assignment-execution-timeout",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:03:01.000Z",
      });
      handle.client
        .prepare("UPDATE execution_runs SET execution_timeout_ms = ? WHERE id = ?")
        .run(1_000, "run-execution-timeout");
      await executions.claim({
        ...claimInput,
        requestId: "claim-execution-timeout",
        leaseSeeds: [
          {
            id: "lease-execution-timeout",
            eventId: "event-claim-execution-timeout",
            tokenHash: "lease-execution-timeout-token-hash",
            tokenEncrypted: "encrypted-execution-timeout-lease-token",
          },
        ],
        now: "2026-08-09T00:03:02.000Z",
        leaseExpiresAt: "2026-08-09T00:04:00.000Z",
      });
      await expect(
        executions.recoverExpired({
          now: "2026-08-09T00:03:03.001Z",
          eventIds: ["event-execution-timeout"],
          limit: 1,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          attemptId: "attempt-execution-timeout",
          reason: "execution_timeout",
          retryScheduled: false,
        }),
      ]);
      expect(
        handle.client
          .prepare("SELECT status, result_code FROM run_attempts WHERE id = ?")
          .get("attempt-execution-timeout"),
      ).toEqual({ status: "timed_out", result_code: "EXECUTION_TIMEOUT" });
      expect(
        handle.client
          .prepare("SELECT event_type, reason_code FROM attempt_state_events WHERE id = ?")
          .get("event-execution-timeout"),
      ).toEqual({
        event_type: "attempt.execution_timed_out",
        reason_code: "EXECUTION_TIMEOUT",
      });
      await expect(
        executions.completeAttempt({
          runnerId: "runner-control",
          attemptId: "attempt-execution-timeout",
          completionId: "completion-after-execution-timeout",
          leaseTokenHash: "lease-execution-timeout-token-hash",
          resultDigest: "late-execution-timeout-digest",
          result: {
            status: "succeeded",
            resultCode: "PASSED",
            summary: "late success after execution timeout",
            durationMs: 1_500,
            artifacts: [],
          },
          eventId: "unused-late-execution-timeout-event",
          acceptedAt: "2026-08-09T00:03:03.100Z",
        }),
      ).resolves.toMatchObject({ disposition: "late", retryScheduled: false });
      await expect(
        executions.recoverExpired({
          now: "2026-08-09T00:03:04.000Z",
          eventIds: ["unused-second-execution-timeout-event"],
          limit: 1,
        }),
      ).resolves.toEqual([]);
      expect(await batches.get("batch-execution-timeout")).toMatchObject({
        status: "failed",
        failedRuns: 0,
        timedOutRuns: 1,
        runs: [expect.objectContaining({ terminalOutcome: "timed_out" })],
        attempts: [
          expect.objectContaining({
            status: "timed_out",
            outcome: "timed_out",
            resultCode: "EXECUTION_TIMEOUT",
          }),
        ],
      });

      await batches.create({
        id: "batch-queue-timeout",
        suiteId: "suite-1",
        suiteName: "Queue timeout suite",
        suiteVersion: 1,
        retryLimit: 0,
        queueTimeoutMs: 1_000,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-queue-timeout",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Queue timeout",
            className: "com.example.QueueTimeoutTest",
          },
        ],
        createdAt: "2026-08-09T00:03:10.000Z",
      });
      await expect(
        batches.reserveAssignments({
          batchId: "batch-queue-timeout",
          decisions: [
            {
              executionRunId: "run-queue-timeout",
              runnerId: "runner-control",
              score: 1,
              attemptId: "unused-attempt-after-queue-timeout",
              assignmentId: "unused-assignment-after-queue-timeout",
            },
          ],
          thresholds: {
            maximumCpuUtilizationPercent: 80,
            maximumMemoryUtilizationPercent: 85,
            maximumLoadPerCpu: 1,
          },
          offlineBefore: "2026-08-09T00:00:30.000Z",
          metricsFreshAfter: "2026-08-09T00:00:30.000Z",
          scheduledAt: "2026-08-09T00:03:11.001Z",
        }),
      ).resolves.toEqual({ reserved: 0, acceptedAttemptIds: [] });
      // 排队超时的 run 从未产生 attempt，不进入回收明细；批次状态断言在下方覆盖。
      await expect(
        executions.recoverExpired({
          now: "2026-08-09T00:03:11.001Z",
          eventIds: ["event-queue-timeout"],
          limit: 1,
        }),
      ).resolves.toEqual([]);
      expect(await batches.get("batch-queue-timeout")).toMatchObject({
        status: "failed",
        timedOutRuns: 1,
        runs: [
          expect.objectContaining({
            status: "failed",
            terminalOutcome: "timed_out",
            terminalReasonCode: "QUEUE_TIMEOUT",
          }),
        ],
        statusHistory: [
          { toStatus: "queued", batchVersion: 1 },
          { fromStatus: "queued", toStatus: "failed", reason: "run.queue_timed_out" },
        ],
      });

      await batches.create({
        id: "batch-held-round-timeout",
        suiteId: "suite-1",
        suiteName: "Held round queue timeout suite",
        suiteVersion: 1,
        retryLimit: 1,
        retryMode: "round",
        queueTimeoutMs: 1_000,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-held-round-timeout",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Held round must not time out",
            className: "com.example.HeldRoundTest",
          },
        ],
        createdAt: "2026-08-09T00:03:12.000Z",
      });
      handle.client
        .prepare(
          `UPDATE execution_runs SET held_round = 2
           WHERE id = 'run-held-round-timeout'`,
        )
        .run();
      await expect(
        executions.recoverExpired({
          now: "2026-08-09T00:03:13.001Z",
          eventIds: ["unused-held-round-timeout-event"],
          limit: 1,
        }),
      ).resolves.toEqual([]);
      expect(await batches.get("batch-held-round-timeout")).toMatchObject({
        status: "queued",
        timedOutRuns: 0,
        runs: [expect.objectContaining({ status: "queued", heldRound: 2 })],
      });

      await batches.create({
        id: "batch-claim-timeout",
        suiteId: "suite-1",
        suiteName: "Claim timeout suite",
        suiteVersion: 1,
        retryLimit: 0,
        claimTimeoutMs: 1_000,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-claim-timeout",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Claim timeout",
            className: "com.example.ClaimTimeoutTest",
          },
        ],
        createdAt: "2026-08-09T00:03:20.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-claim-timeout",
        decisions: [
          {
            executionRunId: "run-claim-timeout",
            runnerId: "runner-control",
            score: 1,
            attemptId: "attempt-claim-timeout",
            assignmentId: "assignment-claim-timeout",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:03:21.000Z",
      });
      await expect(
        executions.recoverExpired({
          now: "2026-08-09T00:03:22.001Z",
          eventIds: ["event-claim-timeout"],
          limit: 1,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          attemptId: "attempt-claim-timeout",
          runnerId: null,
          reason: "claim_timeout",
          retryScheduled: true,
        }),
      ]);
      expect(
        handle.client
          .prepare("SELECT status, result_code FROM run_attempts WHERE id = ?")
          .get("attempt-claim-timeout"),
      ).toEqual({ status: "timed_out", result_code: "ASSIGNMENT_CLAIM_TIMEOUT" });

      await batches.create({
        id: "batch-upload-timeout",
        suiteId: "suite-1",
        suiteName: "Upload timeout suite",
        suiteVersion: 1,
        retryLimit: 0,
        uploadTimeoutMs: 1_000,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-upload-timeout",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Upload timeout",
            className: "com.example.UploadTimeoutTest",
          },
        ],
        createdAt: "2026-08-09T00:03:30.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-upload-timeout",
        decisions: [
          {
            executionRunId: "run-upload-timeout",
            runnerId: "runner-control",
            score: 1,
            attemptId: "attempt-upload-timeout",
            assignmentId: "assignment-upload-timeout",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:03:31.000Z",
      });
      await executions.claim({
        ...claimInput,
        requestId: "claim-upload-timeout",
        leaseSeeds: [
          {
            id: "lease-upload-timeout",
            eventId: "event-claim-upload-timeout",
            tokenHash: "lease-upload-timeout-token-hash",
            tokenEncrypted: "encrypted-upload-timeout-lease-token",
          },
        ],
        now: "2026-08-09T00:03:32.000Z",
        leaseExpiresAt: "2026-08-09T00:04:30.000Z",
      });
      await executions.declareArtifacts({
        runnerId: "runner-control",
        attemptId: "attempt-upload-timeout",
        leaseTokenHash: "lease-upload-timeout-token-hash",
        artifacts: [],
        declaredAt: "2026-08-09T00:03:33.000Z",
      });
      await expect(
        executions.recoverExpired({
          now: "2026-08-09T00:03:34.001Z",
          eventIds: ["event-upload-timeout"],
          limit: 1,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          attemptId: "attempt-upload-timeout",
          runnerId: "runner-control",
          reason: "upload_timeout",
          retryScheduled: true,
        }),
      ]);
      expect(
        handle.client
          .prepare("SELECT status, result_code FROM run_attempts WHERE id = ?")
          .get("attempt-upload-timeout"),
      ).toEqual({ status: "timed_out", result_code: "UPLOAD_TIMEOUT" });
      expect(
        handle.client
          .prepare("SELECT event_type, reason_code FROM attempt_state_events WHERE id = ?")
          .get("event-upload-timeout"),
      ).toEqual({
        event_type: "attempt.upload_timed_out",
        reason_code: "UPLOAD_TIMEOUT",
      });

      await batches.create({
        id: "batch-cancel-queued",
        suiteId: "suite-1",
        suiteName: "Queued cancellation suite",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-cancel-queued",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Queued cancellation",
            className: "com.example.QueuedCancellationTest",
          },
        ],
        createdAt: "2026-08-09T00:04:00.000Z",
      });
      await expect(
        executions.terminateBatch({
          batchId: "batch-cancel-queued",
          actorId: "administrator",
          reason: "operator cancelled queued batch",
          eventId: "event-cancel-queued",
          requestedAt: "2026-08-09T00:04:01.000Z",
        }),
      ).resolves.toBe(1);
      expect(await batches.get("batch-cancel-queued")).toMatchObject({
        status: "cancelled",
        cancelledRuns: 1,
        statusHistory: [
          { toStatus: "queued", batchVersion: 1 },
          { fromStatus: "queued", toStatus: "cancelled", batchVersion: 3 },
        ],
        runs: [expect.objectContaining({ id: "run-cancel-queued", status: "cancelled" })],
        attempts: [],
      });

      await batches.create({
        id: "batch-cancel-assigned",
        suiteId: "suite-1",
        suiteName: "Assigned cancellation suite",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-cancel-assigned",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Assigned cancellation",
            className: "com.example.AssignedCancellationTest",
          },
        ],
        createdAt: "2026-08-09T00:04:02.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-cancel-assigned",
        decisions: [
          {
            executionRunId: "run-cancel-assigned",
            runnerId: "runner-control",
            score: 1,
            attemptId: "attempt-cancel-assigned",
            assignmentId: "assignment-cancel-assigned",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:04:03.000Z",
      });
      await expect(
        executions.terminateBatch({
          batchId: "batch-cancel-assigned",
          actorId: "administrator",
          reason: "operator cancelled assigned batch",
          eventId: "event-cancel-assigned",
          requestedAt: "2026-08-09T00:04:04.000Z",
        }),
      ).resolves.toBe(1);
      expect(await batches.get("batch-cancel-assigned")).toMatchObject({
        status: "cancelled",
        cancelledRuns: 1,
        runs: [expect.objectContaining({ id: "run-cancel-assigned", status: "cancelled" })],
        attempts: [
          expect.objectContaining({
            id: "attempt-cancel-assigned",
            status: "cancelled",
            resultCode: "BATCH_TERMINATED_BEFORE_EXECUTION",
          }),
        ],
      });

      await batches.create({
        id: "batch-terminate-after-retry",
        suiteId: "suite-1",
        suiteName: "Terminate completed assignment suite",
        suiteVersion: 1,
        retryLimit: 1,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-terminate-after-retry",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Terminate after retry",
            className: "com.example.TerminateAfterRetryTest",
          },
        ],
        createdAt: "2026-08-09T00:04:05.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-terminate-after-retry",
        decisions: [
          {
            executionRunId: "run-terminate-after-retry",
            runnerId: "runner-control",
            score: 1,
            attemptId: "attempt-terminate-after-retry",
            assignmentId: "assignment-terminate-after-retry",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:04:06.000Z",
      });
      await executions.claim({
        ...claimInput,
        requestId: "claim-terminate-after-retry",
        leaseSeeds: [
          {
            id: "lease-terminate-after-retry",
            eventId: "event-claim-terminate-after-retry",
            tokenHash: "lease-terminate-after-retry-hash",
            tokenEncrypted: "encrypted-terminate-after-retry-token",
          },
        ],
        now: "2026-08-09T00:04:07.000Z",
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
      });
      await expect(
        executions.completeAttempt({
          runnerId: "runner-control",
          attemptId: "attempt-terminate-after-retry",
          completionId: "completion-terminate-after-retry",
          leaseTokenHash: "lease-terminate-after-retry-hash",
          resultDigest: "result-terminate-after-retry",
          result: {
            status: "failed",
            resultCode: "TESTNG_ASSERTIONS_FAILED",
            summary: "assertion failed",
            durationMs: 1_000,
            artifacts: [],
          },
          eventId: "event-complete-terminate-after-retry",
          acceptedAt: "2026-08-09T00:04:08.000Z",
        }),
      ).resolves.toMatchObject({ retryScheduled: true });
      // 回归原问题：最新 assignment 已 completed，而 run 因重试回到 queued。
      await expect(
        executions.terminateBatch({
          batchId: "batch-terminate-after-retry",
          actorId: "administrator",
          reason: "terminate queued retry",
          eventId: "event-terminate-after-retry",
          requestedAt: "2026-08-09T00:04:09.000Z",
        }),
      ).resolves.toBe(1);
      expect(await batches.get("batch-terminate-after-retry")).toMatchObject({
        status: "cancelled",
        terminationRequestedAt: "2026-08-09T00:04:09.000Z",
        // 批次生命周期已终止，但用例最终统计仍采用“总结”的最后 attempt 结果。
        failedRuns: 1,
        cancelledRuns: 0,
        attempts: [expect.objectContaining({ status: "failed" })],
      });

      await batches.create({
        id: "batch-terminate-running",
        suiteId: "suite-1",
        suiteName: "Graceful termination suite",
        suiteVersion: 1,
        retryLimit: 3,
        environmentVariables: [],
        runnerIds: ["runner-control"],
        runs: [
          {
            id: "run-terminate-running",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Running during termination",
            className: "com.example.RunningDuringTerminationTest",
          },
        ],
        createdAt: "2026-08-09T00:04:10.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-terminate-running",
        decisions: [
          {
            executionRunId: "run-terminate-running",
            runnerId: "runner-control",
            score: 1,
            attemptId: "attempt-terminate-running",
            assignmentId: "assignment-terminate-running",
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:04:11.000Z",
      });
      await executions.claim({
        ...claimInput,
        requestId: "claim-terminate-running",
        leaseSeeds: [
          {
            id: "lease-terminate-running",
            eventId: "event-claim-terminate-running",
            tokenHash: "lease-terminate-running-hash",
            tokenEncrypted: "encrypted-terminate-running-token",
          },
        ],
        now: "2026-08-09T00:04:12.000Z",
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
      });
      await expect(
        executions.terminateBatch({
          batchId: "batch-terminate-running",
          actorId: "administrator",
          reason: "graceful termination",
          eventId: "event-terminate-running-batch",
          requestedAt: "2026-08-09T00:04:13.000Z",
        }),
      ).resolves.toBe(0);
      expect(await batches.get("batch-terminate-running")).toMatchObject({
        status: "running",
        terminationRequestedAt: "2026-08-09T00:04:13.000Z",
        runningRuns: 1,
      });
      await expect(
        executions.renewLease({
          runnerId: "runner-control",
          leaseId: "lease-terminate-running",
          tokenHash: "lease-terminate-running-hash",
          expectedVersion: 1,
          now: "2026-08-09T00:04:14.000Z",
          expiresAt: "2026-08-09T00:05:14.000Z",
        }),
      ).resolves.toMatchObject({ instruction: "continue" });
      await expect(
        executions.completeAttempt({
          runnerId: "runner-control",
          attemptId: "attempt-terminate-running",
          completionId: "completion-terminate-running",
          leaseTokenHash: "lease-terminate-running-hash",
          resultDigest: "result-terminate-running",
          result: {
            status: "failed",
            resultCode: "TESTNG_ASSERTIONS_FAILED",
            summary: "assertion failed after termination request",
            durationMs: 1_000,
            artifacts: [],
          },
          eventId: "event-complete-terminate-running",
          acceptedAt: "2026-08-09T00:04:15.000Z",
        }),
      ).resolves.toMatchObject({ retryScheduled: false });
      expect(await batches.get("batch-terminate-running")).toMatchObject({
        status: "cancelled",
        failedRuns: 1,
        cancelledRuns: 0,
        terminationRequestedAt: "2026-08-09T00:04:13.000Z",
        runs: [expect.objectContaining({ status: "failed" })],
      });
    } finally {
      handle.close();
    }
  });

  it("holds failed runs behind every same-round Jenkins recovery step", async () => {
    const { handle, runners, batches, executions, catalog } = await fixture();
    try {
      await catalog.importCatalog({
        sourceId: "source-round-2",
        objectKey: "jars/round/source-2.jar",
        displayName: "round-source-2",
        importedAt: timestamp,
        inspection: {
          schemaVersion: 1,
          fileName: "source-2.jar",
          sha256: "f".repeat(64),
          sizeBytes: 128,
          classFileCount: 1,
          testClassCount: 1,
          testMethodCount: 1,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [
            {
              className: "com.example.SecondTest",
              packageName: "com.example",
              simpleName: "SecondTest",
              enabled: true,
              classLevelTest: false,
              groups: ["smoke"],
              methods: [
                {
                  methodName: "second",
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
            caseDefinitionId: "case-2",
            caseVersionId: "version-2",
            candidate: {
              className: "com.example.SecondTest",
              packageName: "com.example",
              simpleName: "SecondTest",
              enabled: true,
              classLevelTest: false,
              groups: ["smoke"],
              methods: [
                {
                  methodName: "second",
                  descriptor: "()V",
                  enabled: true,
                  annotationSource: "method",
                  groups: ["smoke"],
                  dependsOnMethods: [],
                  dependsOnGroups: [],
                },
              ],
            },
            methods: [{ methodId: "method-2", methodIndex: 0 }],
          },
        ],
      });
      await runners.register({
        id: "runner-round",
        bootstrapTokenHash: "bootstrap-round",
        credentialHash: "credential-round",
        name: "round-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 2,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await runners.heartbeat({
        runnerId: "runner-round",
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 2,
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
        id: "batch-round",
        suiteId: "suite-round",
        suiteName: "Round",
        suiteVersion: 1,
        retryLimit: 1,
        retryMode: "round",
        environmentVariables: [],
        runnerIds: ["runner-round"],
        roundRecoveries: [
          {
            ruleId: "recovery-app",
            afterRound: 1,
            jenkinsJobUrl: "https://jenkins.internal/job/reset-app/",
            apiKeyCiphertext: "encrypted-app",
            waitMinutes: 3,
          },
          {
            ruleId: "recovery-database",
            afterRound: 1,
            jenkinsJobUrl: "https://jenkins.internal/job/reset-database/",
            apiKeyCiphertext: "encrypted-database",
            waitMinutes: 7,
          },
        ],
        runs: [
          {
            id: "run-round-a",
            caseDefinitionId: "case-1",
            caseVersion: 1,
            displayName: "Round A",
            className: "com.example.SmokeTest",
          },
          {
            id: "run-round-b",
            caseDefinitionId: "case-2",
            caseVersion: 1,
            displayName: "Round B",
            className: "com.example.SecondTest",
          },
        ],
        createdAt: "2026-08-09T00:01:00.000Z",
      });
      await batches.reserveAssignments({
        batchId: "batch-round",
        decisions: [
          {
            executionRunId: "run-round-a",
            runnerId: "runner-round",
            score: 1,
            attemptId: "attempt-round-a",
            assignmentId: "assignment-round-a",
          },
          {
            executionRunId: "run-round-b",
            runnerId: "runner-round",
            score: 1,
            attemptId: "attempt-round-b",
            assignmentId: "assignment-round-b",
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
      await executions.claim({
        runnerId: "runner-round",
        requestId: "claim-round",
        availableSlots: 2,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        leaseSeeds: [
          {
            id: "lease-round-a",
            eventId: "event-claim-round-a",
            tokenHash: "lease-token-hash-round-a",
            tokenEncrypted: "encrypted-lease-token-round-a",
          },
          {
            id: "lease-round-b",
            eventId: "event-claim-round-b",
            tokenHash: "lease-token-hash-round-b",
            tokenEncrypted: "encrypted-lease-token-round-b",
          },
        ],
        now: "2026-08-09T00:01:02.000Z",
        leaseExpiresAt: "2026-08-09T00:01:47.000Z",
      });

      // 第 1 轮：run A 失败。round 模式下它应被扣留（held_round=2），不进入调度快照。
      await executions.completeAttempt({
        runnerId: "runner-round",
        attemptId: "attempt-round-a",
        completionId: "completion-round-a",
        leaseTokenHash: "lease-token-hash-round-a",
        resultDigest: "digest-round-a",
        result: {
          status: "failed",
          resultCode: "TEST_ASSERTION_FAILED",
          summary: "round A failed",
          durationMs: 500,
          artifacts: [],
        },
        eventId: "event-complete-round-a",
        acceptedAt: "2026-08-09T00:01:10.000Z",
      });

      const snapshotMidRound = await batches.getSchedulingSnapshot(
        "batch-round",
        "2026-08-09T00:00:30.000Z",
      );
      // run B 仍在途，run A 已扣留：快照不应包含任何可调度 run。
      expect(snapshotMidRound?.queuedRuns).toEqual([]);
      expect(
        handle.client
          .prepare("SELECT status, held_round FROM execution_runs WHERE id = 'run-round-a'")
          .get(),
      ).toEqual({ status: "queued", held_round: 2 });

      // 第 1 轮：run B 失败。整轮结束后两个 run 一起释放进入第 2 轮。
      await executions.completeAttempt({
        runnerId: "runner-round",
        attemptId: "attempt-round-b",
        completionId: "completion-round-b",
        leaseTokenHash: "lease-token-hash-round-b",
        resultDigest: "digest-round-b",
        result: {
          status: "failed",
          resultCode: "TEST_ASSERTION_FAILED",
          summary: "round B failed",
          durationMs: 500,
          artifacts: [],
        },
        eventId: "event-complete-round-b",
        acceptedAt: "2026-08-09T00:01:20.000Z",
      });

      const snapshotBehindRecovery = await batches.getSchedulingSnapshot(
        "batch-round",
        "2026-08-09T00:00:30.000Z",
      );
      expect(snapshotBehindRecovery?.queuedRuns).toEqual([]);
      expect(
        handle.client
          .prepare(
            `SELECT rule_id, status FROM run_batch_round_recoveries
             WHERE batch_id = 'batch-round' ORDER BY rule_id`,
          )
          .all(),
      ).toEqual([
        { rule_id: "recovery-app", status: "pending" },
        { rule_id: "recovery-database", status: "pending" },
      ]);
      expect(
        handle.client
          .prepare("SELECT current_round FROM run_batches WHERE id = 'batch-round'")
          .get(),
      ).toEqual({ current_round: 1 });
      expect(
        handle.client
          .prepare("SELECT status, held_round FROM execution_runs WHERE id = 'run-round-a'")
          .get(),
      ).toEqual({ status: "queued", held_round: 2 });
      const recoveryDetails = await batches.get("batch-round");
      expect(recoveryDetails?.roundRecoveries).toEqual([
        expect.objectContaining({
          ruleId: "recovery-app",
          status: "pending",
          activatedAt: "2026-08-09T00:01:20.000Z",
        }),
        expect.objectContaining({
          ruleId: "recovery-database",
          status: "pending",
          activatedAt: "2026-08-09T00:01:20.000Z",
        }),
      ]);
      expect(JSON.stringify(recoveryDetails?.roundRecoveries)).not.toContain("encrypted-");

      // 外部 Jenkins 成功和各自等待由编排服务推进；这里将两个步骤置为到期，
      // 验证第一步只完成自身、第二步才原子释放整个下一轮。
      handle.client
        .prepare(
          `UPDATE run_batch_round_recoveries
           SET status = 'waiting', available_at = '2026-08-09T00:01:21.000Z'
           WHERE batch_id = 'batch-round' AND status = 'pending'`,
        )
        .run();
      const recoveries = new SqliteRoundRecoveryRepository(handle);
      const recoveryClaims = await recoveries.claimDue({
        workerId: "round-recovery-worker",
        now: "2026-08-09T00:01:21.000Z",
        leaseExpiresAt: "2026-08-09T00:01:51.000Z",
        limit: 10,
      });
      expect(recoveryClaims).toHaveLength(2);
      await expect(
        recoveries.completeWaitingStep({
          batchId: "batch-round",
          ruleId: recoveryClaims[0]!.ruleId,
          workerId: "round-recovery-worker",
          updatedAt: "2026-08-09T00:01:21.000Z",
        }),
      ).resolves.toEqual({ outcome: "step_completed", remainingSteps: 1 });
      await expect(
        recoveries.completeWaitingStep({
          batchId: "batch-round",
          ruleId: recoveryClaims[1]!.ruleId,
          workerId: "round-recovery-worker",
          updatedAt: "2026-08-09T00:01:21.000Z",
        }),
      ).resolves.toEqual({ outcome: "round_releasing" });
      await expect(
        recoveries.completeRoundRelease({
          batchId: "batch-round",
          ruleId: recoveryClaims[1]!.ruleId,
          workerId: "round-recovery-worker",
          updatedAt: "2026-08-09T00:01:21.000Z",
        }),
      ).resolves.toBe(true);

      const snapshotAfterRecovery = await batches.getSchedulingSnapshot(
        "batch-round",
        "2026-08-09T00:00:30.000Z",
      );
      expect(snapshotAfterRecovery?.queuedRuns.map((run) => run.id).sort()).toEqual([
        "run-round-a",
        "run-round-b",
      ]);
      expect(
        handle.client
          .prepare("SELECT current_round FROM run_batches WHERE id = 'batch-round'")
          .get(),
      ).toEqual({ current_round: 2 });
      expect(
        handle.client
          .prepare("SELECT status, held_round FROM execution_runs WHERE id = 'run-round-a'")
          .get(),
      ).toEqual({ status: "queued", held_round: 0 });

      // 第 2 轮：两个 run 再次断言失败；全部正常执行结束后批次进入“执行完成”。
      await batches.reserveAssignments({
        batchId: "batch-round",
        decisions: [
          {
            executionRunId: "run-round-a",
            runnerId: "runner-round",
            score: 1,
            attemptId: "attempt-round-a-2",
            assignmentId: "assignment-round-a-2",
          },
          {
            executionRunId: "run-round-b",
            runnerId: "runner-round",
            score: 1,
            attemptId: "attempt-round-b-2",
            assignmentId: "assignment-round-b-2",
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
        runnerId: "runner-round",
        requestId: "claim-round-2",
        availableSlots: 2,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        leaseSeeds: [
          {
            id: "lease-round-a-2",
            eventId: "event-claim-round-a-2",
            tokenHash: "lease-token-hash-round-a-2",
            tokenEncrypted: "encrypted-lease-token-round-a-2",
          },
          {
            id: "lease-round-b-2",
            eventId: "event-claim-round-b-2",
            tokenHash: "lease-token-hash-round-b-2",
            tokenEncrypted: "encrypted-lease-token-round-b-2",
          },
        ],
        now: "2026-08-09T00:02:02.000Z",
        leaseExpiresAt: "2026-08-09T00:02:47.000Z",
      });
      const secondRoundA = await executions.completeAttempt({
        runnerId: "runner-round",
        attemptId: "attempt-round-a-2",
        completionId: "completion-round-a-2",
        leaseTokenHash: "lease-token-hash-round-a-2",
        resultDigest: "digest-round-a-2",
        result: {
          status: "failed",
          resultCode: "TEST_ASSERTION_FAILED",
          summary: "round A failed again",
          durationMs: 500,
          artifacts: [],
        },
        eventId: "event-complete-round-a-2",
        acceptedAt: "2026-08-09T00:02:10.000Z",
      });
      expect(secondRoundA).toMatchObject({
        disposition: "accepted",
        retryScheduled: false,
      });
      await executions.completeAttempt({
        runnerId: "runner-round",
        attemptId: "attempt-round-b-2",
        completionId: "completion-round-b-2",
        leaseTokenHash: "lease-token-hash-round-b-2",
        resultDigest: "digest-round-b-2",
        result: {
          status: "failed",
          resultCode: "TEST_ASSERTION_FAILED",
          summary: "round B failed again",
          durationMs: 500,
          artifacts: [],
        },
        eventId: "event-complete-round-b-2",
        acceptedAt: "2026-08-09T00:02:20.000Z",
      });
      expect(await batches.get("batch-round")).toMatchObject({
        status: "succeeded",
        succeededRuns: 0,
        failedRuns: 2,
        runs: [
          expect.objectContaining({ id: "run-round-a", status: "failed", attemptCount: 2 }),
          expect.objectContaining({ id: "run-round-b", status: "failed", attemptCount: 2 }),
        ],
      });
    } finally {
      handle.close();
    }
  });
});

function structuredTestNgResult(status: "passed" | "failed") {
  const counts = {
    total: 1,
    passed: status === "passed" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
    skipped: 0,
    configurationFailures: 0,
  };
  return {
    ...counts,
    detailsTruncated: false,
    suites: [
      {
        ...counts,
        name: "Control suite",
        durationMs: 1_000,
        tests: [
          {
            ...counts,
            name: "Control test",
            durationMs: 1_000,
            classes: [
              {
                ...counts,
                name: "example.ControlTest",
                durationMs: 1_000,
                methods: [
                  {
                    name: status === "passed" ? "passes" : "fails",
                    status,
                    configuration: false,
                    durationMs: 1_000,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function executionsProjectId(
  handle: ReturnType<typeof createSqliteDatabase>,
  attemptId: string,
): Promise<string | null> {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-attempt-logs-"));
  temporaryDirectories.push(directory);
  return new SqliteExecutionControlRepository(
    handle,
    createAttemptLogStore(directory),
  ).resolveAttemptProjectId(attemptId);
}

const timestamp = "2026-08-09T00:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-management-"));
  temporaryDirectories.push(directory);
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  const catalog = new SqliteCaseCatalogRepository(handle);
  await new SqliteProjectStructureRepository(handle).createVersion({
    id: "project-version-1",
    projectId: "00000000-0000-7000-8000-000000000001",
    name: "V1",
    normalizedName: "v1",
    recordedAt: timestamp,
  });
  await catalog.importCatalog({
    projectId: "00000000-0000-7000-8000-000000000001",
    projectVersionId: "project-version-1",
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
    executions: new SqliteExecutionControlRepository(
      handle,
      createAttemptLogStore(resolve(directory, "attempt-logs")),
    ),
  };
}
