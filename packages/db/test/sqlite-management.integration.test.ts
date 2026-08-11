import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { SqliteExecutionControlRepository } from "../src/sqlite-execution-control";
import { SqliteExecutionEnvironmentRepository } from "../src/sqlite-execution-environment";
import { SqliteExecutionSecretRepository } from "../src/sqlite-execution-secret";
import { SqliteRunnerRepository } from "../src/sqlite-runner";
import { scheduleExecutionRuns } from "@autoforge/domain";
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
      expect(withCase.items[0]?.caseDefinition.className).toBe("com.example.SmokeTest");

      const empty = await suites.removeCase({
        suiteId: "suite-1",
        caseDefinitionId: "case-1",
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
      expect(recovered).toBe(1);
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
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
          "secrets:on-demand-v1",
        ],
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

      await batches.create({
        id: "batch-project-b",
        projectId: "project-b",
        suiteId: "suite-project-b",
        suiteName: "Project B suite",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: ["runner-scheduling"],
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
      await expect(
        batches.listPage({
          projectIds: ["project-b"],
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

  it("retries queued batches when a selected runner reports fresh metrics", async () => {
    const { handle, catalog, suites, runners, batches } = await fixture();
    try {
      await suites.create({ id: "suite-dynamic", name: "Dynamic", createdAt: timestamp });
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
      handle.client
        .prepare(
          `INSERT INTO users
           (id, username, normalized_username, display_name, source, status,
            force_password_change, failed_login_attempts, created_at, updated_at, version)
           VALUES ('dynamic-actor', 'dynamic-actor', 'dynamic-actor', 'Dynamic Actor',
                   'local', 'active', 0, 0, ?, ?, 1)`,
        )
        .run(timestamp, timestamp);
      const secrets = new SqliteExecutionSecretRepository(handle);
      await secrets.create({
        id: "dynamic-secret",
        versionId: "dynamic-secret-version-1",
        projectId: "00000000-0000-7000-8000-000000000001",
        name: "Dynamic token",
        normalizedName: "dynamic token",
        description: "",
        valueEncrypted: "encrypted-dynamic-secret",
        actorId: "dynamic-actor",
        recordedAt: timestamp,
      });
      const environments = new SqliteExecutionEnvironmentRepository(handle);
      await environments.create({
        id: "dynamic-environment",
        versionId: "dynamic-environment-version-1",
        projectId: "00000000-0000-7000-8000-000000000001",
        name: "Dynamic staging",
        normalizedName: "dynamic staging",
        description: "",
        variables: [{ name: "BASE_URL", value: "https://first.example.test" }],
        secretBindings: [{ name: "API_TOKEN", secretId: "dynamic-secret" }],
        actorId: "dynamic-actor",
        recordedAt: timestamp,
      });
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
        environments,
        {
          catalog,
          objectStore: { exists: async () => true } as unknown as JarObjectStorePort,
        },
      );
      await expect(
        scheduler.create({
          suiteId: "suite-dynamic",
          runnerIds: ["runner-dynamic"],
          retryLimit: 1,
          environmentVersionId: "dynamic-environment-version-1",
        }),
      ).rejects.toMatchObject({
        code: "RUN_BATCH_PREFLIGHT_FAILED",
        details: {
          ready: false,
          blockers: [expect.objectContaining({ code: "RUNNER_SECRET_CAPABILITY_MISSING" })],
        },
      });
      await runners.heartbeat({
        runnerId: "runner-dynamic",
        labels: ["java", "testng"],
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
          "secrets:on-demand-v1",
        ],
        maxConcurrency: 1,
        busySlots: 0,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        recordedAt: "2026-08-09T00:01:00.000Z",
      });
      const queued = await scheduler.create({
        suiteId: "suite-dynamic",
        runnerIds: ["runner-dynamic"],
        retryLimit: 1,
        environmentVersionId: "dynamic-environment-version-1",
      });
      expect(queued).toMatchObject({
        status: "queued",
        environmentId: "dynamic-environment",
        environmentVersionId: "dynamic-environment-version-1",
        environmentVariables: [{ name: "BASE_URL", value: "https://first.example.test" }],
        secretBindings: [
          {
            name: "API_TOKEN",
            secretId: "dynamic-secret",
            secretVersionId: "dynamic-secret-version-1",
          },
        ],
      });
      await environments.update({
        environmentId: "dynamic-environment",
        expectedRevision: 1,
        actorId: "dynamic-actor",
        recordedAt: "2026-08-09T00:01:00.500Z",
        nextVersion: {
          id: "dynamic-environment-version-2",
          variables: [{ name: "BASE_URL", value: "https://second.example.test" }],
        },
      });
      await expect(
        environments.listVersions("dynamic-environment", ["00000000-0000-7000-8000-000000000001"]),
      ).resolves.toMatchObject([{ version: 2 }, { version: 1 }]);
      await expect(
        environments.listReferences(
          "dynamic-environment",
          ["00000000-0000-7000-8000-000000000001"],
          10,
        ),
      ).resolves.toMatchObject({
        total: 1,
        items: [
          {
            batchId: queued.id,
            environmentVersionId: "dynamic-environment-version-1",
            suiteName: "Dynamic",
          },
        ],
      });
      await expect(
        environments.listReferences("dynamic-environment", ["another-project"], 10),
      ).resolves.toEqual({ items: [], total: 0 });
      await expect(scheduler.get(queued.id)).resolves.toMatchObject({
        environmentVersionId: "dynamic-environment-version-1",
        environmentVariables: [{ value: "https://first.example.test" }],
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
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
          "secrets:on-demand-v1",
        ],
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
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
          "secrets:on-demand-v1",
        ],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: timestamp,
      });
      await runners.heartbeat({
        runnerId: "runner-control",
        labels: ["java", "testng"],
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
          "secrets:on-demand-v1",
        ],
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
      handle.client
        .prepare(
          `INSERT INTO users
           (id, username, normalized_username, display_name, source, status,
            force_password_change, failed_login_attempts, created_at, updated_at, version)
           VALUES ('control-actor', 'control-actor', 'control-actor', 'Control Actor',
                   'local', 'active', 0, 0, ?, ?, 1)`,
        )
        .run(timestamp, timestamp);
      const secrets = new SqliteExecutionSecretRepository(handle);
      await secrets.create({
        id: "control-secret",
        versionId: "control-secret-version",
        projectId: "00000000-0000-7000-8000-000000000001",
        name: "Control token",
        normalizedName: "control token",
        description: "",
        valueEncrypted: "encrypted-control-secret",
        actorId: "control-actor",
        recordedAt: timestamp,
      });
      await batches.create({
        id: "batch-control",
        suiteId: "suite-snapshot",
        suiteName: "Control",
        suiteVersion: 1,
        retryLimit: 1,
        environmentVariables: [],
        secretBindings: [
          {
            name: "API_TOKEN",
            secretId: "control-secret",
            secretVersionId: "control-secret-version",
          },
        ],
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
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "java:21.0.8",
          "testng:7.11.0",
          "secrets:on-demand-v1",
        ],
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
        secretReferences: [
          {
            name: "API_TOKEN",
            secretId: "control-secret",
            secretVersionId: "control-secret-version",
          },
        ],
      });
      await expect(
        executions.acquireAttemptSecrets({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          leaseTokenHash: "lease-token-hash",
          now: "2026-08-09T00:01:02.500Z",
        }),
      ).resolves.toEqual([
        {
          name: "API_TOKEN",
          secretId: "control-secret",
          secretVersionId: "control-secret-version",
          valueEncrypted: "encrypted-control-secret",
        },
      ]);
      await executions.recordAttemptSecretAccess({
        id: "secret-audit-control",
        runnerId: "runner-control",
        attemptId: "attempt-control",
        requestId: "secret-request-control",
        secretIds: ["control-secret"],
        recordedAt: "2026-08-09T00:01:02.500Z",
      });
      expect(
        handle.client
          .prepare(
            "SELECT actor_type, actor_id, action, resource_id, details_json FROM audit_events WHERE id = ?",
          )
          .get("secret-audit-control"),
      ).toEqual({
        actor_type: "runner",
        actor_id: "runner-control",
        action: "execution_secret.access",
        resource_id: "attempt-control",
        details_json: JSON.stringify({ secretCount: 1, secretIds: ["control-secret"] }),
      });
      await expect(
        executions.acquireAttemptSecrets({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          leaseTokenHash: "wrong-token-hash",
          now: "2026-08-09T00:01:02.600Z",
        }),
      ).rejects.toMatchObject({ code: "ATTEMPT_TRANSFER_FORBIDDEN" });
      expect(
        handle.client
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id = ?")
          .get("secret-audit-rejected"),
      ).toEqual({ count: 0 });
      await secrets.setStatus({
        secretId: "control-secret",
        expectedRevision: 1,
        status: "disabled",
        recordedAt: "2026-08-09T00:01:02.700Z",
      });
      await expect(
        executions.acquireAttemptSecrets({
          runnerId: "runner-control",
          attemptId: "attempt-control",
          leaseTokenHash: "lease-token-hash",
          now: "2026-08-09T00:01:02.800Z",
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_SECRET_UNAVAILABLE" });
      expect(
        handle.client
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id = ?")
          .get("secret-audit-disabled"),
      ).toEqual({ count: 0 });
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
      expect(await batches.get("batch-control")).toMatchObject({
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
      ).resolves.toBe(1);
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
      ).resolves.toBe(0);
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
      ).resolves.toBe(0);
      await expect(
        executions.recoverExpired({
          now: "2026-08-09T00:03:11.001Z",
          eventIds: ["event-queue-timeout"],
          limit: 1,
        }),
      ).resolves.toBe(1);
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
      ).resolves.toBe(1);
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
      ).resolves.toBe(1);
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
        executions.cancelBatch({
          batchId: "batch-cancel-queued",
          actorId: "administrator",
          reason: "operator cancelled queued batch",
          eventIds: ["event-cancel-queued"],
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
        executions.cancelBatch({
          batchId: "batch-cancel-assigned",
          actorId: "administrator",
          reason: "operator cancelled assigned batch",
          eventIds: ["event-cancel-assigned"],
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
            resultCode: "CANCELLED_BY_USER",
          }),
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
  return new SqliteExecutionControlRepository(handle).resolveAttemptProjectId(attemptId);
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
