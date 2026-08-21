import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";
import { scheduleExecutionRuns } from "@autoforge/domain";
import { CaseSourceService, type JarObjectStorePort } from "@autoforge/application";
import type { JobEnvelope } from "@autoforge/contracts";

import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresIdentityAccessRepository } from "../src/postgres-identity-access";
import {
  PostgresCaseCatalogRepository,
  PostgresCaseSuiteRepository,
  PostgresRunnerRepository,
} from "../src/postgres-platform-repository";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";
import { PostgresExecutionControlRepository } from "../src/postgres-execution-control";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";
import { createAttemptLogStore, type AttemptLogStore } from "../src/attempt-log-store";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

// PG 日志同样外置到每批次独立 SQLite 文件；测试用临时目录承载批次日志。
function createTestAttemptLogs(): { store: AttemptLogStore; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "autoforge-pg-test-logs-"));
  return { store: createAttemptLogStore(directory), directory };
}

function cleanupTestAttemptLogs(logs: { store: AttemptLogStore; directory: string }): void {
  logs.store.close();
  rmSync(logs.directory, { recursive: true, force: true });
}

describe.skipIf(!connectionString)("PostgreSQL platform repositories", () => {
  it("applies migrations and persists suites and runner heartbeats", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const suites = new PostgresCaseSuiteRepository(handle);
    const catalog = new PostgresCaseCatalogRepository(handle);
    const runners = new PostgresRunnerRepository(handle);
    const batches = new PostgresRunBatchRepository(handle);
    const attemptLogs = createTestAttemptLogs();
    const executions = new PostgresExecutionControlRepository(handle, attemptLogs.store);
    const operations = new PostgresPlatformOperationsRepository(handle, attemptLogs.store);
    const structures = new PostgresProjectStructureRepository(handle);
    const suiteId = randomUUID();
    const runnerId = randomUUID();
    const credentialHash = randomUUID();
    const bootstrapTokenHash = randomUUID();
    const secondProjectId = randomUUID();
    const secondProjectBatchId = `batch-project-${runnerId}`;
    try {
      await handle.ready;
      await handle.pool.query(
        `INSERT INTO projects (id, name, slug, is_default, archived, created_at, updated_at)
         VALUES ($1, $2, $3, false, false, $4, $4)`,
        [secondProjectId, "Second project", `second-${runnerId}`, "2026-08-09T00:00:00.000Z"],
      );
      const projectVersion = await structures.createVersion({
        id: randomUUID(),
        projectId: secondProjectId,
        name: "2026.08",
        normalizedName: "2026.08",
        recordedAt: "2026-08-09T00:00:00.000Z",
      });
      const firstBundleId = randomUUID();
      await structures.replaceVersionRuntimeAsset(projectVersion.id, {
        id: firstBundleId,
        projectId: secondProjectId,
        kind: "jar-bundle",
        sourceType: "url",
        fileName: "dependencies-1.zip",
        url: "https://jenkins.internal/dependencies-1.zip",
        sha256: "d".repeat(64),
        sizeBytes: 2_048,
        archiveFormat: "zip",
        createdAt: "2026-08-09T00:00:01.000Z",
      });
      const secondBundleId = randomUUID();
      await structures.replaceVersionRuntimeAsset(projectVersion.id, {
        id: secondBundleId,
        projectId: secondProjectId,
        kind: "jar-bundle",
        sourceType: "url",
        fileName: "dependencies-2.zip",
        url: "https://jenkins.internal/dependencies-2.zip",
        sha256: "e".repeat(64),
        sizeBytes: 4_096,
        archiveFormat: "zip",
        createdAt: "2026-08-09T00:00:02.000Z",
      });
      await expect(
        structures.getAdapterConfiguration(secondProjectId, projectVersion.id),
      ).resolves.toMatchObject({
        projectVersionId: projectVersion.id,
        jarBundleAsset: { id: secondBundleId },
        revision: 2,
      });
      await expect(
        handle.pool.query("SELECT id FROM project_runtime_assets WHERE id = $1", [firstBundleId]),
      ).resolves.toMatchObject({ rowCount: 0 });
      await suites.create({
        id: suiteId,
        name: "PostgreSQL smoke suite",
        createdAt: "2026-08-09T00:00:00.000Z",
      });
      expect((await suites.get(suiteId))?.name).toBe("PostgreSQL smoke suite");

      await runners.register({
        id: runnerId,
        bootstrapTokenHash,
        credentialHash,
        name: "postgres-runner",
        os: "linux",
        architecture: "arm64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java"],
        capabilities: [],
        maxConcurrency: 2,
        terminalEnabled: false,
        recordedAt: "2026-08-09T00:00:00.000Z",
      });
      await expect(
        runners.register({
          id: randomUUID(),
          bootstrapTokenHash,
          credentialHash: randomUUID(),
          name: "duplicate-bootstrap",
          os: "linux",
          architecture: "arm64",
          agentVersion: "0.2.0",
          protocolVersion: 1,
          labels: [],
          capabilities: [],
          maxConcurrency: 1,
          terminalEnabled: false,
          recordedAt: "2026-08-09T00:00:00.000Z",
        }),
      ).resolves.toBeNull();
      const heartbeat = await runners.heartbeat({
        runnerId,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21", "testng:7.11.0"],
        maxConcurrency: 2,
        busySlots: 1,
        agentVersion: "0.2.0",
        terminalEnabled: true,
        resourceSnapshot: {
          cpuUtilizationPercent: 25,
          memoryUtilizationPercent: 35,
          loadAverage1m: 0.75,
          logicalCpuCount: 4,
          observedAt: "2026-08-09T00:01:00.000Z",
        },
        recordedAt: "2026-08-09T00:01:00.000Z",
      });
      expect(heartbeat).toMatchObject({
        busySlots: 1,
        labels: ["java", "testng"],
        terminalEnabled: true,
        resourceSnapshot: expect.objectContaining({ cpuUtilizationPercent: 25 }),
      });

      await catalog.importCatalog({
        sourceId: `source-${runnerId}`,
        objectKey: `jars/${runnerId}/source.jar`,
        displayName: "PostgreSQL source",
        importedAt: "2026-08-09T00:01:00.000Z",
        inspection: {
          schemaVersion: 1,
          fileName: "source.jar",
          sha256: "b".repeat(64),
          sizeBytes: 128,
          classFileCount: 1,
          testClassCount: 1,
          testMethodCount: 1,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [postgresCaseCandidate()],
        },
        cases: [
          {
            caseDefinitionId: `case-${runnerId}`,
            caseVersionId: `version-${runnerId}`,
            candidate: postgresCaseCandidate(),
            methods: [{ methodId: `method-${runnerId}`, methodIndex: 0 }],
          },
        ],
      });

      await batches.create({
        id: `batch-${runnerId}`,
        suiteId,
        suiteName: "PostgreSQL smoke suite",
        suiteVersion: 1,
        retryLimit: 1,
        environmentVariables: [],
        runnerIds: [runnerId],
        runs: [
          {
            id: `run-${runnerId}`,
            caseDefinitionId: `case-${runnerId}`,
            caseVersion: 1,
            displayName: "PostgreSQL smoke",
            className: "example.PostgresSmoke",
          },
        ],
        createdAt: "2026-08-09T00:01:00.000Z",
      });
      const thresholds = {
        maximumCpuUtilizationPercent: 80,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
      };
      const snapshot = await batches.getSchedulingSnapshot(
        `batch-${runnerId}`,
        "2026-08-09T00:00:30.000Z",
      );
      const plan = scheduleExecutionRuns({
        runs: snapshot!.queuedRuns,
        candidates: snapshot!.candidates,
        thresholds,
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
      });
      await batches.reserveAssignments({
        batchId: `batch-${runnerId}`,
        decisions: plan.decisions.map((decision) => ({
          ...decision,
          attemptId: `attempt-${runnerId}`,
          assignmentId: `assignment-${runnerId}`,
        })),
        thresholds,
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:01:01.000Z",
      });
      expect(await batches.get(`batch-${runnerId}`)).toMatchObject({
        status: "scheduled",
        assignedRuns: 1,
        version: 2,
        statusHistory: [
          { toStatus: "queued", batchVersion: 1 },
          { fromStatus: "queued", toStatus: "scheduled", batchVersion: 2 },
        ],
      });
      await batches.create({
        id: secondProjectBatchId,
        projectId: secondProjectId,
        suiteId,
        suiteName: "Second project suite",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: [runnerId],
        runs: [
          {
            id: `run-project-${runnerId}`,
            caseDefinitionId: `case-${runnerId}`,
            caseVersion: 1,
            displayName: "Second project smoke",
            className: "example.SecondProjectSmoke",
          },
        ],
        createdAt: "2026-08-09T00:01:02.000Z",
      });
      await expect(batches.list(10, [secondProjectId])).resolves.toMatchObject([
        { id: secondProjectBatchId, projectId: secondProjectId },
      ]);
      await expect(batches.get(`batch-${runnerId}`, [secondProjectId])).resolves.toBeNull();
      await handle.pool.query(
        `INSERT INTO case_sources (
           id, display_name, original_file_name, object_key, sha256, size_bytes,
           class_count, method_count, status, warnings_json, inspection_json,
           authoritative, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'ready', '[]', '{}', false, $7, $7)`,
        [
          `dependency-${runnerId}`,
          "PostgreSQL support dependency",
          "support.jar",
          `jars/${runnerId}/support.jar`,
          "c".repeat(64),
          64,
          "2026-08-09T00:01:01.000Z",
        ],
      );
      const assignmentSnapshot = await handle.pool.query<{ execution_spec_json: string }>(
        "SELECT execution_spec_json FROM assignments WHERE id = $1",
        [`assignment-${runnerId}`],
      );
      const executionSpec = JSON.parse(assignmentSnapshot.rows[0]!.execution_spec_json) as {
        inputs: Array<Record<string, unknown>>;
      };
      executionSpec.inputs.push({
        inputId: `dependency-${runnerId}`,
        kind: "dependency-jar",
        targetPath: "inputs/lib/support.jar",
        mediaType: "application/java-archive",
        sizeBytes: 64,
        sha256: "c".repeat(64),
      });
      await handle.pool.query("UPDATE assignments SET execution_spec_json = $1 WHERE id = $2", [
        JSON.stringify(executionSpec),
        `assignment-${runnerId}`,
      ]);
      const claimed = await executions.claim({
        runnerId,
        requestId: `claim-${runnerId}`,
        availableSlots: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        leaseSeeds: [
          {
            id: `lease-${runnerId}`,
            eventId: `claim-event-${runnerId}`,
            tokenHash: `lease-token-${runnerId}`,
            tokenEncrypted: `encrypted-${runnerId}`,
          },
        ],
        now: "2026-08-09T00:01:02.000Z",
        leaseExpiresAt: "2026-08-09T00:01:47.000Z",
      });
      expect(claimed).toHaveLength(1);
      await expect(
        executions.resolveAttemptInput({
          runnerId,
          attemptId: `attempt-${runnerId}`,
          inputId: `source-${runnerId}`,
          leaseTokenHash: `lease-token-${runnerId}`,
          now: "2026-08-09T00:01:03.000Z",
        }),
      ).resolves.toMatchObject({ objectKey: `jars/${runnerId}/source.jar`, sizeBytes: 128 });
      await expect(
        executions.resolveAttemptInput({
          runnerId,
          attemptId: `attempt-${runnerId}`,
          inputId: `dependency-${runnerId}`,
          leaseTokenHash: `lease-token-${runnerId}`,
          now: "2026-08-09T00:01:03.000Z",
        }),
      ).resolves.toEqual({
        objectKey: `jars/${runnerId}/support.jar`,
        sizeBytes: 64,
        sha256: "c".repeat(64),
      });
      await expect(
        executions.completeAttempt({
          runnerId,
          attemptId: `attempt-${runnerId}`,
          completionId: `completion-${runnerId}`,
          leaseTokenHash: `lease-token-${runnerId}`,
          resultDigest: `digest-${runnerId}`,
          result: {
            status: "succeeded",
            resultCode: "PASSED",
            summary: "passed",
            durationMs: 100,
            testNg: postgresTestNgResult(),
            artifacts: [],
          },
          eventId: `complete-event-${runnerId}`,
          acceptedAt: "2026-08-09T00:01:20.000Z",
        }),
      ).resolves.toMatchObject({ disposition: "accepted", retryScheduled: false });
      await expect(batches.get(`batch-${runnerId}`)).resolves.toMatchObject({
        attempts: [
          {
            durationMs: 100,
            testNg: {
              total: 1,
              suites: [{ tests: [{ classes: [{ methods: [{ name: "passes" }] }] }] }],
            },
          },
        ],
      });
      await expect(
        operations.readAnalytics({
          filter: { caseDefinitionId: `case-${runnerId}` },
          generatedAt: "2026-08-09T00:02:00.000Z",
        }),
      ).resolves.toMatchObject({
        sampleCount: 1,
        passed: 1,
        failed: 0,
        successRate: 1,
        failures: [],
        trend: [{ total: 1, passed: 1, failed: 0, skipped: 0 }],
      });
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [secondProjectBatchId]);
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [`batch-${runnerId}`]);
      await handle.pool.query("DELETE FROM case_versions WHERE source_id IN ($1, $2)", [
        `dependency-${runnerId}`,
        `source-${runnerId}`,
      ]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [`dependency-${runnerId}`]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [`source-${runnerId}`]);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      await handle.pool.query("DELETE FROM runner_bootstrap_uses WHERE token_hash = $1", [
        bootstrapTokenHash,
      ]);
      await handle.pool.query("DELETE FROM case_suites WHERE id = $1", [suiteId]);
      await handle.pool.query("DELETE FROM projects WHERE id = $1", [secondProjectId]);
      cleanupTestAttemptLogs(attemptLogs);
      await handle.close();
    }
  });

  it("persists role deactivation, project ownership and administrator views", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const identity = new PostgresIdentityAccessRepository(handle);
    const roleId = randomUUID();
    const userId = randomUUID();
    const ownerId = randomUUID();
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const tokenHash = randomUUID();
    const now = "2026-08-09T00:00:00.000Z";
    try {
      await handle.ready;
      await handle.pool.query(
        `INSERT INTO users
         (id, username, normalized_username, display_name, source, status,
          force_password_change, failed_login_attempts, created_at, updated_at, version)
         VALUES ($1, $2, $2, 'Binding User', 'local', 'active', false, 0, $3, $3, 1),
                ($4, $5, $5, 'Project Owner', 'local', 'active', false, 0, $3, $3, 1)`,
        [userId, `binding-${userId}`, now, ownerId, `owner-${ownerId}`],
      );
      const created = await identity.createRole({
        id: roleId,
        key: `recovery-${roleId}`,
        name: "Recovery Admin",
        description: "Custom recovery administrator",
        scope: "system",
        permissions: ["user.manage", "role.manage"],
        createdAt: now,
      });
      expect(created.active).toBe(true);
      await identity.assignSystemRole(userId, roleId, ownerId, now);
      await handle.pool.query(
        `INSERT INTO user_sessions (id, user_id, token_hash, expires_at, last_seen_at, created_at)
         VALUES ($1, $2, $3, '2099-01-01T00:00:00.000Z', $4, $4)`,
        [sessionId, userId, tokenHash, now],
      );

      expect((await identity.resolveSession(tokenHash, now))?.systemPermissions).toContain(
        "user.manage",
      );

      const deactivated = await identity.updateRole({ id: roleId, active: false, updatedAt: now });
      expect(deactivated.active).toBe(false);
      expect((await identity.resolveSession(tokenHash, now))?.systemPermissions).not.toContain(
        "user.manage",
      );
      expect(
        (await identity.listSystemRoleBindingsForActiveUsers()).some(
          (binding) => binding.userId === userId && binding.roleId === roleId,
        ),
      ).toBe(false);

      await identity.updateRole({ id: roleId, active: true, updatedAt: now });
      expect(
        (await identity.listSystemRoleBindingsForActiveUsers()).some(
          (binding) => binding.userId === userId && binding.roleId === roleId,
        ),
      ).toBe(true);

      await handle.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);
      expect(
        (await identity.listSystemRoleBindingsForActiveUsers()).some(
          (binding) => binding.userId === userId && binding.roleId === roleId,
        ),
      ).toBe(false);

      const project = await identity.createProject({
        id: projectId,
        name: "Owned project",
        slug: `owned-${projectId}`,
        ownerUserId: ownerId,
        createdAt: now,
      });
      expect(project.ownerUserId).toBe(ownerId);
      const transferred = await identity.transferProjectOwner({
        projectId,
        ownerUserId: userId,
        updatedAt: now,
      });
      expect(transferred.ownerUserId).toBe(userId);
      expect(
        (await identity.listProjects()).find((candidate) => candidate.id === projectId)
          ?.ownerUserId,
      ).toBe(userId);
    } finally {
      await handle.pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
      await handle.pool.query("DELETE FROM user_sessions WHERE id = $1", [sessionId]);
      await handle.pool.query("DELETE FROM user_system_roles WHERE role_id = $1", [roleId]);
      await handle.pool.query("DELETE FROM roles WHERE id = $1", [roleId]);
      await handle.pool.query("DELETE FROM users WHERE id IN ($1, $2)", [userId, ownerId]);
      await handle.close();
    }
  });

  it("rotates, revokes and deregisters runner credentials", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const runners = new PostgresRunnerRepository(handle);
    const suites = new PostgresCaseSuiteRepository(handle);
    const catalog = new PostgresCaseCatalogRepository(handle);
    const batches = new PostgresRunBatchRepository(handle);
    const attemptLogs = createTestAttemptLogs();
    const executions = new PostgresExecutionControlRepository(handle, attemptLogs.store);
    const runnerId = randomUUID();
    const suiteId = randomUUID();
    const batchId = `batch-${runnerId}`;
    const bootstrapTokenHash = randomUUID();
    const now = "2026-08-09T00:00:00.000Z";
    try {
      await handle.ready;
      await runners.register({
        id: runnerId,
        bootstrapTokenHash,
        credentialHash: `credential-v1-${runnerId}`,
        name: "postgres-rotate-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21", "testng:7.11.0"],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: now,
      });
      expect((await runners.findByCredentialHash(`credential-v1-${runnerId}`, now))?.id).toBe(
        runnerId,
      );

      const requested = await runners.requestCredentialRotation({
        runnerId,
        requestedAt: "2026-08-09T00:00:45.000Z",
      });
      expect(requested.credentialRotationRequestedAt).toBe("2026-08-09T00:00:45.000Z");

      const rotated = await runners.rotateCredential({
        runnerId,
        credentialHash: `credential-v2-${runnerId}`,
        previousCredentialValidUntil: "2026-08-09T00:15:00.000Z",
        rotatedAt: "2026-08-09T00:01:00.000Z",
      });
      expect(rotated.credentialVersion).toBe(2);
      expect(rotated.credentialRotationRequestedAt).toBeUndefined();
      expect(
        (
          await runners.findByCredentialHash(
            `credential-v1-${runnerId}`,
            "2026-08-09T00:10:00.000Z",
          )
        )?.id,
      ).toBe(runnerId);
      expect(
        await runners.findByCredentialHash(`credential-v1-${runnerId}`, "2026-08-09T00:16:00.000Z"),
      ).toBeNull();

      const revoked = await runners.revokeCredential({
        runnerId,
        revokedAt: "2026-08-09T00:20:00.000Z",
      });
      expect(revoked.credentialRevokedAt).toBe("2026-08-09T00:20:00.000Z");
      expect(
        await runners.findByCredentialHash(`credential-v1-${runnerId}`, "2026-08-09T00:10:00.000Z"),
      ).toBeNull();

      await runners.heartbeat({
        runnerId,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21", "testng:7.11.0"],
        maxConcurrency: 1,
        busySlots: 0,
        agentVersion: "0.2.2",
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
      await suites.create({ id: suiteId, name: "Rotate suite", createdAt: now });
      await catalog.importCatalog({
        sourceId: `source-${runnerId}`,
        objectKey: `jars/${runnerId}/source.jar`,
        displayName: "Rotate source",
        importedAt: "2026-08-09T00:20:31.000Z",
        inspection: {
          schemaVersion: 1,
          fileName: "source.jar",
          sha256: "d".repeat(64),
          sizeBytes: 128,
          classFileCount: 1,
          testClassCount: 1,
          testMethodCount: 1,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [postgresCaseCandidate()],
        },
        cases: [
          {
            caseDefinitionId: `case-${runnerId}`,
            caseVersionId: `version-${runnerId}`,
            candidate: postgresCaseCandidate(),
            methods: [{ methodId: `method-${runnerId}`, methodIndex: 0 }],
          },
        ],
      });
      await batches.create({
        id: batchId,
        suiteId,
        suiteName: "Rotate suite",
        suiteVersion: 1,
        retryLimit: 1,
        environmentVariables: [],
        runnerIds: [runnerId],
        runs: [
          {
            id: `run-${runnerId}`,
            caseDefinitionId: `case-${runnerId}`,
            caseVersion: 1,
            displayName: "Rotate",
            className: "example.PostgresSmoke",
          },
        ],
        createdAt: "2026-08-09T00:20:32.000Z",
      });
      await batches.reserveAssignments({
        batchId,
        decisions: [
          {
            executionRunId: `run-${runnerId}`,
            runnerId,
            score: 1,
            attemptId: `attempt-${runnerId}`,
            assignmentId: `assignment-${runnerId}`,
          },
        ],
        thresholds: {
          maximumCpuUtilizationPercent: 80,
          maximumMemoryUtilizationPercent: 85,
          maximumLoadPerCpu: 1,
        },
        offlineBefore: "2026-08-09T00:20:00.000Z",
        metricsFreshAfter: "2026-08-09T00:20:00.000Z",
        scheduledAt: "2026-08-09T00:20:33.000Z",
      });
      const claimed = await executions.claim({
        runnerId,
        requestId: `claim-${runnerId}`,
        availableSlots: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21", "testng:7.11.0"],
        leaseSeeds: [
          {
            id: `lease-${runnerId}`,
            eventId: `claim-event-${runnerId}`,
            tokenHash: `lease-token-${runnerId}`,
            tokenEncrypted: `encrypted-${runnerId}`,
          },
        ],
        now: "2026-08-09T00:20:34.000Z",
        leaseExpiresAt: "2026-08-09T00:21:19.000Z",
      });
      expect(claimed).toHaveLength(1);

      const deregistered = await runners.deregister({
        runnerId,
        deregisteredAt: "2026-08-09T00:21:00.000Z",
      });
      expect(deregistered.deregisteredAt).toBe("2026-08-09T00:21:00.000Z");
      expect(deregistered.state).toBe("disabled");
      const lease = await handle.pool.query<{ expires_at: string }>(
        "SELECT expires_at FROM assignment_leases WHERE id = $1",
        [`lease-${runnerId}`],
      );
      expect(lease.rows[0]?.expires_at).toBe("2026-08-09T00:21:00.000Z");

      const recovered = await executions.recoverExpired({
        now: "2026-08-09T00:21:00.001Z",
        eventIds: [`recover-event-${runnerId}`],
        limit: 10,
      });
      expect(recovered).toEqual([
        {
          attemptId: `attempt-${runnerId}`,
          batchId,
          executionRunId: `run-${runnerId}`,
          runnerId,
          reason: "lease_expired",
          retryScheduled: true,
        },
      ]);
      const run = await handle.pool.query<{ status: string }>(
        "SELECT status FROM execution_runs WHERE id = $1",
        [`run-${runnerId}`],
      );
      expect(run.rows[0]?.status).toBe("queued");
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [batchId]);
      await handle.pool.query("DELETE FROM case_versions WHERE source_id = $1", [
        `source-${runnerId}`,
      ]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [`source-${runnerId}`]);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      await handle.pool.query("DELETE FROM runner_bootstrap_uses WHERE token_hash = $1", [
        bootstrapTokenHash,
      ]);
      await handle.pool.query("DELETE FROM case_suites WHERE id = $1", [suiteId]);
      cleanupTestAttemptLogs(attemptLogs);
      await handle.close();
    }
  });
  it("purges a deregistered runner and hides it from listings", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const runners = new PostgresRunnerRepository(handle);
    const runnerId = randomUUID();
    const bootstrapTokenHash = randomUUID();
    const now = "2026-08-09T00:00:00.000Z";
    try {
      await handle.ready;
      await runners.register({
        id: runnerId,
        bootstrapTokenHash,
        credentialHash: `credential-purge-${runnerId}`,
        name: "postgres-purge-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        labels: ["java"],
        capabilities: ["executor:testng-v1"],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: now,
      });
      expect((await runners.list("2026-08-08T23:59:00.000Z", 500)).map((row) => row.id)).toContain(
        runnerId,
      );

      await runners.deregister({ runnerId, deregisteredAt: "2026-08-09T00:10:00.000Z" });
      const purged = await runners.purge({ runnerId, purgedAt: "2026-08-09T00:11:00.000Z" });
      expect(purged.purgedAt).toBe("2026-08-09T00:11:00.000Z");
      expect(purged.labels).toEqual([]);
      expect(purged.capabilities).toEqual([]);

      expect(
        (await runners.list("2026-08-08T23:59:00.000Z", 500)).map((row) => row.id),
      ).not.toContain(runnerId);
      expect(
        await runners.findByCredentialHash(
          `credential-purge-${runnerId}`,
          "2026-08-09T00:12:00.000Z",
        ),
      ).toBeNull();
      // get 不过滤墓碑记录，供重复清除时幂等返回。
      expect((await runners.get(runnerId, "2026-08-09T00:12:00.000Z"))?.purgedAt).toBe(
        "2026-08-09T00:11:00.000Z",
      );
      const stored = await handle.pool.query<{ credential_hash: string }>(
        "SELECT credential_hash FROM runners WHERE id = $1",
        [runnerId],
      );
      expect(stored.rows[0]?.credential_hash).toBe(`purged:${runnerId}`);

      // 同名新机器重新注册不受墓碑记录影响。
      const replacementId = randomUUID();
      const replacementBootstrapTokenHash = randomUUID();
      const replacement = await runners.register({
        id: replacementId,
        bootstrapTokenHash: replacementBootstrapTokenHash,
        credentialHash: `credential-replacement-${replacementId}`,
        name: "postgres-purge-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        labels: [],
        capabilities: [],
        maxConcurrency: 1,
        terminalEnabled: false,
        recordedAt: "2026-08-09T00:13:00.000Z",
      });
      expect(replacement?.id).toBe(replacementId);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [replacementId]);
      await handle.pool.query("DELETE FROM runner_bootstrap_uses WHERE token_hash = $1", [
        replacementBootstrapTokenHash,
      ]);
    } finally {
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      await handle.pool.query("DELETE FROM runner_bootstrap_uses WHERE token_hash = $1", [
        bootstrapTokenHash,
      ]);
      await handle.close();
    }
  });
  it("edits case metadata and restores version history", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const catalog = new PostgresCaseCatalogRepository(handle);
    const actorId = randomUUID();
    const sourceId = randomUUID();
    const caseDefinitionId = randomUUID();
    const now = "2026-08-09T00:00:00.000Z";
    try {
      await handle.ready;
      await handle.pool.query(
        `INSERT INTO users
         (id, username, normalized_username, display_name, source, status,
          force_password_change, failed_login_attempts, created_at, updated_at, version)
         VALUES ($1, $2, $2, 'Case Actor', 'local', 'active', false, 0, $3, $3, 1)`,
        [actorId, `case-actor-${actorId}`, now],
      );
      await catalog.importCatalog({
        sourceId,
        objectKey: `jars/${sourceId}/fixture.jar`,
        displayName: "Case fixture",
        importedAt: now,
        inspection: {
          schemaVersion: 1,
          fileName: "fixture.jar",
          sha256: "e".repeat(64),
          sizeBytes: 128,
          classFileCount: 1,
          testClassCount: 1,
          testMethodCount: 1,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [postgresCaseCandidate()],
        },
        cases: [
          {
            caseDefinitionId,
            caseVersionId: randomUUID(),
            candidate: postgresCaseCandidate(),
            methods: [{ methodId: randomUUID(), methodIndex: 0 }],
          },
        ],
      });

      const updated = await catalog.updateCaseDefinition({
        caseDefinitionId,
        expectedRevision: 1,
        displayName: "冒烟测试",
        tags: ["smoke"],
        enabled: false,
        actorId,
        updatedAt: "2026-08-09T00:05:00.000Z",
      });
      expect(updated).toMatchObject({
        displayName: "冒烟测试",
        tags: ["smoke"],
        enabled: false,
        revision: 2,
        updatedBy: actorId,
      });
      await expect(
        catalog.updateCaseDefinition({
          caseDefinitionId,
          expectedRevision: 1,
          displayName: "并发修改",
          actorId,
          updatedAt: "2026-08-09T00:06:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "CASE_DEFINITION_REVISION_CONFLICT" });

      const restored = await catalog.restoreCaseVersion({
        caseDefinitionId,
        expectedRevision: 2,
        versionId: randomUUID(),
        version: 2,
        sourceId,
        snapshot: { ...postgresCaseCandidate(), groups: ["smoke", "nightly"] },
        changeReason: "manual.restore",
        methodIds: [randomUUID()],
        actorId,
        restoredAt: "2026-08-09T00:07:00.000Z",
      });
      expect(restored).toMatchObject({
        currentVersion: 2,
        revision: 3,
        groups: ["smoke", "nightly"],
      });

      const versions = await catalog.listCaseVersions(caseDefinitionId, 10);
      expect(versions.map((version) => version.version)).toEqual([2, 1]);
      expect(versions[0]).toMatchObject({ changeReason: "manual.restore", createdBy: actorId });
      expect((await catalog.getCaseVersion(caseDefinitionId, 1))?.changeReason).toBe(
        "source.import",
      );
      expect(await catalog.getCaseVersion(caseDefinitionId, 99)).toBeNull();
    } finally {
      await handle.pool.query("DELETE FROM case_versions WHERE source_id = $1", [sourceId]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [sourceId]);
      await handle.pool.query("DELETE FROM users WHERE id = $1", [actorId]);
      await handle.close();
    }
  });

  it("tracks suite lifecycle snapshots and freezes batch policy", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const suites = new PostgresCaseSuiteRepository(handle);
    const catalog = new PostgresCaseCatalogRepository(handle);
    const batches = new PostgresRunBatchRepository(handle);
    const runners = new PostgresRunnerRepository(handle);
    const suiteId = randomUUID();
    const copyId = randomUUID();
    const sourceId = randomUUID();
    const caseDefinitionId = randomUUID();
    const runnerId = randomUUID();
    const batchId = `batch-${suiteId}`;
    const now = "2026-08-09T00:00:00.000Z";
    try {
      await handle.ready;
      await catalog.importCatalog({
        sourceId,
        objectKey: `jars/${sourceId}/fixture.jar`,
        displayName: "Suite fixture",
        importedAt: now,
        inspection: {
          schemaVersion: 1,
          fileName: "fixture.jar",
          sha256: "f".repeat(64),
          sizeBytes: 128,
          classFileCount: 1,
          testClassCount: 1,
          testMethodCount: 1,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [postgresCaseCandidate()],
        },
        cases: [
          {
            caseDefinitionId,
            caseVersionId: randomUUID(),
            candidate: postgresCaseCandidate(),
            methods: [{ methodId: randomUUID(), methodIndex: 0 }],
          },
        ],
      });
      await suites.create({ id: suiteId, name: "PG suite", createdAt: now });
      await suites.addCases({
        suiteId,
        items: [{ id: randomUUID(), caseDefinitionId }],
        versionId: randomUUID(),
        updatedAt: now,
      });
      const updated = await suites.updateSuite({
        suiteId,
        expectedRevision: 2,
        versionId: randomUUID(),
        changeReason: "suite.update:policy",
        updatedAt: "2026-08-09T00:02:00.000Z",
        name: "PG nightly",
        policy: {
          executor: "testng",
          adapter: {
            enabled: false,
            suiteName: "",
            testName: "",
            environmentAddresses: [],
          },
          priority: 5,
          concurrency: 2,
          retryLimit: 3,
          retryMode: "immediate",
          queueTimeoutMs: 120_000,
          claimTimeoutMs: 300_000,
          uploadTimeoutMs: 600_000,
          runnerIds: [runnerId],
          runnerLabels: ["gpu"],
          artifactPatterns: ["reports/**"],
        },
      });
      expect(updated).toMatchObject({ name: "PG nightly", version: 3, revision: 3 });
      expect(updated.policy).toMatchObject({ concurrency: 2, runnerLabels: ["gpu"] });
      const snapshots = await handle.pool.query<{
        version: number;
        change_reason: string;
        snapshot_json: string;
      }>(
        "SELECT version, change_reason, snapshot_json FROM case_suite_versions WHERE suite_id = $1 ORDER BY version",
        [suiteId],
      );
      expect(snapshots.rows.map((row) => [row.version, row.change_reason])).toEqual([
        [2, "suite.cases.add"],
        [3, "suite.update:policy"],
      ]);
      await expect(
        suites.updateSuite({
          suiteId,
          expectedRevision: 2,
          versionId: randomUUID(),
          changeReason: "suite.update:rename",
          updatedAt: now,
          name: "stale",
        }),
      ).rejects.toMatchObject({ code: "CASE_SUITE_REVISION_CONFLICT" });

      const copied = await suites.copySuite({
        id: copyId,
        name: "PG suite 副本",
        policy: updated.policy,
        items: [{ id: randomUUID(), caseDefinitionId }],
        versionId: randomUUID(),
        createdAt: "2026-08-09T00:03:00.000Z",
      });
      expect(copied).toMatchObject({ version: 1, revision: 1, caseCount: 1, status: "active" });

      await runners.register({
        id: runnerId,
        bootstrapTokenHash: randomUUID(),
        credentialHash: randomUUID(),
        name: "policy-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        labels: ["java", "testng", "gpu"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2"],
        maxConcurrency: 2,
        terminalEnabled: false,
        recordedAt: now,
      });
      await batches.create({
        id: batchId,
        suiteId,
        suiteName: "PG nightly",
        suiteVersion: 3,
        retryLimit: 3,
        priority: 5,
        queueTimeoutMs: 120_000,
        executionTimeoutMs: 600_000,
        environmentVariables: [],
        runnerIds: [runnerId],
        policy: {
          executor: "testng",
          concurrency: 2,
          runnerLabels: ["gpu"],
          artifactPatterns: ["reports/**"],
        },
        runs: [
          {
            id: `run-${suiteId}`,
            caseDefinitionId,
            caseVersion: 1,
            displayName: "PG nightly",
            className: "example.PostgresSmoke",
            parameters: { SUITE: "nightly" },
          },
        ],
        createdAt: "2026-08-09T00:04:00.000Z",
      });
      await expect(batches.get(batchId)).resolves.toMatchObject({
        policy: { concurrency: 2, runnerLabels: ["gpu"], artifactPatterns: ["reports/**"] },
      });
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [batchId]);
      await handle.pool.query("DELETE FROM case_suite_versions WHERE suite_id IN ($1, $2)", [
        suiteId,
        copyId,
      ]);
      await handle.pool.query("DELETE FROM case_suites WHERE id IN ($1, $2)", [suiteId, copyId]);
      await handle.pool.query("DELETE FROM case_versions WHERE source_id = $1", [sourceId]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [sourceId]);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      await handle.close();
    }
  });

  it("holds failed runs until the whole round completes in round retry mode", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const catalog = new PostgresCaseCatalogRepository(handle);
    const runners = new PostgresRunnerRepository(handle);
    const batches = new PostgresRunBatchRepository(handle);
    const attemptLogs = createTestAttemptLogs();
    const executions = new PostgresExecutionControlRepository(handle, attemptLogs.store);
    const suiteId = randomUUID();
    const sourceId = randomUUID();
    const sourceId2 = randomUUID();
    const caseDefinitionId1 = randomUUID();
    const caseDefinitionId2 = randomUUID();
    const runnerId = randomUUID();
    const batchId = `batch-round-${suiteId}`;
    const now = "2026-08-09T00:00:00.000Z";
    const runIdA = `run-round-a-${suiteId}`;
    const runIdB = `run-round-b-${suiteId}`;
    const attemptIdA = `attempt-round-a-${suiteId}`;
    const attemptIdB = `attempt-round-b-${suiteId}`;
    const assignmentIdA = `assignment-round-a-${suiteId}`;
    const assignmentIdB = `assignment-round-b-${suiteId}`;
    try {
      await handle.ready;
      // 导入两个 case 供 round 测试使用
      await catalog.importCatalog({
        sourceId,
        objectKey: `jars/${sourceId}/round1.jar`,
        displayName: "Round source 1",
        importedAt: now,
        inspection: {
          schemaVersion: 1,
          fileName: "round1.jar",
          sha256: "a".repeat(64),
          sizeBytes: 128,
          classFileCount: 1,
          testClassCount: 1,
          testMethodCount: 1,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [postgresCaseCandidate()],
        },
        cases: [
          {
            caseDefinitionId: caseDefinitionId1,
            caseVersionId: randomUUID(),
            candidate: postgresCaseCandidate(),
            methods: [{ methodId: randomUUID(), methodIndex: 0 }],
          },
        ],
      });
      await catalog.importCatalog({
        sourceId: sourceId2,
        objectKey: `jars/${sourceId2}/round2.jar`,
        displayName: "Round source 2",
        importedAt: now,
        inspection: {
          schemaVersion: 1,
          fileName: "round2.jar",
          sha256: "b".repeat(64),
          sizeBytes: 128,
          classFileCount: 1,
          testClassCount: 1,
          testMethodCount: 1,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: [postgresCaseCandidate()],
        },
        cases: [
          {
            caseDefinitionId: caseDefinitionId2,
            caseVersionId: randomUUID(),
            candidate: postgresCaseCandidate(),
            methods: [{ methodId: randomUUID(), methodIndex: 0 }],
          },
        ],
      });
      await runners.register({
        id: runnerId,
        bootstrapTokenHash: randomUUID(),
        credentialHash: randomUUID(),
        name: "round-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: 2,
        terminalEnabled: false,
        recordedAt: now,
      });
      await runners.heartbeat({
        runnerId,
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
        id: batchId,
        suiteId,
        suiteName: "Round",
        suiteVersion: 1,
        retryLimit: 1,
        retryMode: "round",
        environmentVariables: [],
        runnerIds: [runnerId],
        runs: [
          {
            id: runIdA,
            caseDefinitionId: caseDefinitionId1,
            caseVersion: 1,
            displayName: "Round A",
            className: "example.PostgresSmoke",
          },
          {
            id: runIdB,
            caseDefinitionId: caseDefinitionId2,
            caseVersion: 1,
            displayName: "Round B",
            className: "example.PostgresSmoke",
          },
        ],
        createdAt: "2026-08-09T00:01:00.000Z",
      });
      await batches.reserveAssignments({
        batchId,
        decisions: [
          {
            executionRunId: runIdA,
            runnerId,
            score: 1,
            attemptId: attemptIdA,
            assignmentId: assignmentIdA,
          },
          {
            executionRunId: runIdB,
            runnerId,
            score: 1,
            attemptId: attemptIdB,
            assignmentId: assignmentIdB,
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
        runnerId,
        requestId: `claim-round-${suiteId}`,
        availableSlots: 2,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        leaseSeeds: [
          {
            id: `lease-round-a-${suiteId}`,
            eventId: `event-claim-round-a-${suiteId}`,
            tokenHash: "lease-token-hash-round-a",
            tokenEncrypted: "encrypted-lease-token-round-a",
          },
          {
            id: `lease-round-b-${suiteId}`,
            eventId: `event-claim-round-b-${suiteId}`,
            tokenHash: "lease-token-hash-round-b",
            tokenEncrypted: "encrypted-lease-token-round-b",
          },
        ],
        now: "2026-08-09T00:01:02.000Z",
        leaseExpiresAt: "2026-08-09T00:01:47.000Z",
      });

      // 第 1 轮：run A 失败。round 模式下它应被扣留（held_round=2），不进入调度快照。
      await executions.completeAttempt({
        runnerId,
        attemptId: attemptIdA,
        completionId: `completion-round-a-${suiteId}`,
        leaseTokenHash: "lease-token-hash-round-a",
        resultDigest: `digest-round-a-${suiteId}`,
        result: {
          status: "failed",
          resultCode: "TEST_ASSERTION_FAILED",
          summary: "round A failed",
          durationMs: 500,
          artifacts: [],
        },
        eventId: `event-complete-round-a-${suiteId}`,
        acceptedAt: "2026-08-09T00:01:10.000Z",
      });

      const snapshotMidRound = await batches.getSchedulingSnapshot(
        batchId,
        "2026-08-09T00:00:30.000Z",
      );
      // run B 仍在途，run A 已扣留：快照不应包含任何可调度 run。
      expect(snapshotMidRound?.queuedRuns).toEqual([]);
      const runAAfterFirstFailure = await handle.pool.query<{
        status: string;
        held_round: number;
      }>("SELECT status, held_round FROM execution_runs WHERE id = $1", [runIdA]);
      expect(runAAfterFirstFailure.rows[0]).toEqual({ status: "queued", held_round: 2 });

      // 第 1 轮：run B 失败。整轮结束后两个 run 一起释放进入第 2 轮。
      await executions.completeAttempt({
        runnerId,
        attemptId: attemptIdB,
        completionId: `completion-round-b-${suiteId}`,
        leaseTokenHash: "lease-token-hash-round-b",
        resultDigest: `digest-round-b-${suiteId}`,
        result: {
          status: "failed",
          resultCode: "TEST_ASSERTION_FAILED",
          summary: "round B failed",
          durationMs: 500,
          artifacts: [],
        },
        eventId: `event-complete-round-b-${suiteId}`,
        acceptedAt: "2026-08-09T00:01:20.000Z",
      });

      const snapshotAfterRound = await batches.getSchedulingSnapshot(
        batchId,
        "2026-08-09T00:00:30.000Z",
      );
      expect(snapshotAfterRound?.queuedRuns.map((run) => run.id).sort()).toEqual(
        [runIdA, runIdB].sort(),
      );
      const batchAfterRound = await handle.pool.query<{ current_round: number }>(
        "SELECT current_round FROM run_batches WHERE id = $1",
        [batchId],
      );
      expect(batchAfterRound.rows[0]).toEqual({ current_round: 2 });
      const runAReleased = await handle.pool.query<{ status: string; held_round: number }>(
        "SELECT status, held_round FROM execution_runs WHERE id = $1",
        [runIdA],
      );
      expect(runAReleased.rows[0]).toEqual({ status: "queued", held_round: 0 });
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [batchId]);
      await handle.pool.query("DELETE FROM case_versions WHERE source_id IN ($1, $2)", [
        sourceId,
        sourceId2,
      ]);
      await handle.pool.query("DELETE FROM case_sources WHERE id IN ($1, $2)", [
        sourceId,
        sourceId2,
      ]);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      cleanupTestAttemptLogs(attemptLogs);
      await handle.close();
    }
  });

  it("compares, syncs and deletes case sources with cleanup jobs", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const catalog = new PostgresCaseCatalogRepository(handle);
    const currentSourceId = randomUUID();
    const candidateSourceId = randomUUID();
    const unreferencedSourceId = randomUUID();
    const now = "2026-08-09T00:00:00.000Z";
    const cleanupJobIds: string[] = [];
    try {
      await handle.ready;
      await importPostgresSource(catalog, currentSourceId, "a".repeat(64), [
        { name: "example.PgKept", groups: ["smoke"] },
        { name: "example.PgRemoved", groups: ["smoke"] },
      ]);
      await importPostgresSource(catalog, candidateSourceId, "b".repeat(64), [
        { name: "example.PgKept", groups: ["nightly"] },
        { name: "example.PgAdded", groups: ["nightly"] },
      ]);
      await importPostgresSource(catalog, unreferencedSourceId, "c".repeat(64), []);
      await catalog.setAuthoritativeSource(currentSourceId);

      const objectStore = {
        storageKind: "minio",
        delete: vi.fn(async () => undefined),
      } as unknown as JarObjectStorePort & { delete: ReturnType<typeof vi.fn> };
      const queue = {
        publish: vi.fn<(job: JobEnvelope) => Promise<"published">>(async () => "published"),
      };
      let generated = 0;
      const service = new CaseSourceService(
        catalog,
        objectStore,
        { now: () => new Date(now) },
        { next: () => `pg-generated-${++generated}` },
        queue as never,
      );

      const comparison = await service.compareSources(candidateSourceId);
      expect(comparison.truncated).toBe(false);
      expect(comparison.currentSourceId).toBe(currentSourceId);
      expect(comparison.added.map((entry) => entry.className)).toEqual(["example.PgAdded"]);
      expect(comparison.changed.map((entry) => entry.className)).toEqual(["example.PgKept"]);
      expect(comparison.removed.map((entry) => entry.className)).toEqual(["example.PgRemoved"]);
      expect(await catalog.getSourceComparison(comparison.id)).toEqual(comparison);

      const promoted = await service.confirmSync(candidateSourceId, {
        comparisonId: comparison.id,
        expectedRevision: 1,
      });
      expect(promoted.authoritative).toBe(true);
      expect((await catalog.getAuthoritativeSource(promoted.projectId))?.id).toBe(
        candidateSourceId,
      );
      const synchronizedCases = await catalog.listCases({
        query: "example.PgKept",
        limit: 10,
      });
      expect(synchronizedCases.items).toHaveLength(1);
      const synchronizedCase = synchronizedCases.items[0]!;
      expect(synchronizedCase).toMatchObject({
        sourceId: candidateSourceId,
        currentVersion: 2,
        groups: ["nightly"],
      });
      expect(await catalog.listCaseVersions(synchronizedCase.id, 10)).toMatchObject([
        { version: 2, sourceId: candidateSourceId, changeReason: "source.sync" },
        { version: 1, sourceId: currentSourceId, changeReason: "source.import" },
      ]);

      const staleComparison = await service.compareSources(unreferencedSourceId);
      await catalog.setAuthoritativeSource(currentSourceId);
      await expect(
        service.confirmSync(unreferencedSourceId, {
          comparisonId: staleComparison.id,
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "CASE_SOURCE_SYNC_STALE" });

      await expect(
        service.deleteSource(candidateSourceId, { expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "CASE_SOURCE_IN_USE" });

      const deleting = await service.deleteSource(unreferencedSourceId, {
        expectedRevision: 1,
      });
      expect(deleting.lifecycleStatus).toBe("deleting");
      const envelope = queue.publish.mock.calls[0]?.[0];
      expect(envelope?.kind).toBe("object-cleanup");
      const cleanupJobId = String(envelope?.payload.cleanupJobId);
      cleanupJobIds.push(cleanupJobId);
      expect(await catalog.getCleanupJob(cleanupJobId)).toMatchObject({
        status: "pending",
        objectKey: `jars/${unreferencedSourceId}/fixture.jar`,
      });

      await service.objectCleanupHandler()(
        {
          schemaVersion: 1,
          messageId: "pg-message-1",
          runId: cleanupJobId,
          attempt: 1,
          createdAt: now,
          priority: 0,
          deduplicationKey: `object-cleanup:${cleanupJobId}`,
          kind: "object-cleanup",
          payload: { cleanupJobId },
        },
        new AbortController().signal,
      );
      expect(objectStore.delete).toHaveBeenCalledWith(`jars/${unreferencedSourceId}/fixture.jar`);
      expect(await catalog.getCleanupJob(cleanupJobId)).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
      });
    } finally {
      await handle.pool.query(
        "DELETE FROM case_source_comparisons WHERE candidate_source_id IN ($1, $2, $3) OR current_source_id IN ($1, $2, $3)",
        [currentSourceId, candidateSourceId, unreferencedSourceId],
      );
      if (cleanupJobIds.length > 0) {
        await handle.pool.query("DELETE FROM cleanup_jobs WHERE id = ANY($1)", [cleanupJobIds]);
      }
      await handle.pool.query("DELETE FROM case_versions WHERE source_id = ANY($1)", [
        [currentSourceId, candidateSourceId, unreferencedSourceId],
      ]);
      await handle.pool.query("DELETE FROM case_sources WHERE id IN ($1, $2, $3)", [
        currentSourceId,
        candidateSourceId,
        unreferencedSourceId,
      ]);
      await handle.close();
    }
  });
  it("atomically persists an analytics export and transactional outbox event", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const repository = new PostgresPlatformOperationsRepository(handle);
    const exportId = randomUUID();
    const messageId = randomUUID();
    const requestedBy = randomUUID();
    try {
      await handle.ready;
      const job = await repository.createAnalyticsExportJob({
        job: {
          id: exportId,
          requestedBy,
          filter: {},
          format: "json",
          status: "queued",
          progressPercent: 0,
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        projectIds: [],
        idempotencyKey: messageId,
        dispatchJob: {
          schemaVersion: 1,
          messageId,
          runId: exportId,
          attempt: 1,
          createdAt: "2026-08-09T00:00:00.000Z",
          priority: 0,
          deduplicationKey: `analytics-export:${exportId}:1`,
          kind: "analytics-export",
          payload: { exportId },
        },
      });
      expect(job.status).toBe("queued");
      const outbox = await handle.pool.query(
        "SELECT message_id FROM transactional_outbox WHERE message_id=$1",
        [messageId],
      );
      expect(outbox.rows).toHaveLength(1);
      await expect(
        repository.claimAnalyticsExportJob({
          jobId: exportId,
          startedAt: "2026-08-09T00:00:01.000Z",
        }),
      ).resolves.toMatchObject({ projectIds: [], job: { status: "running" } });
      await expect(repository.getAnalyticsExportJob(exportId, randomUUID())).resolves.toBeNull();
    } finally {
      await handle.pool.query("DELETE FROM transactional_outbox WHERE message_id=$1", [messageId]);
      await handle.pool.query("DELETE FROM analytics_export_jobs WHERE id=$1", [exportId]);
      await handle.close();
    }
  });

  it("lists the latest terminal run outcome per case definition", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const catalog = new PostgresCaseCatalogRepository(handle);
    const firstBatchId = randomUUID();
    const secondBatchId = randomUUID();
    const projectId = randomUUID();
    const casePrefix = `case-${randomUUID()}-`;
    const caseMulti = `${casePrefix}multi`;
    const caseStale = `${casePrefix}stale`;
    const caseQueuedOnly = `${casePrefix}queued`;
    const caseCancelled = `${casePrefix}cancelled`;
    const caseNullOutcome = `${casePrefix}legacy`;
    try {
      await handle.ready;
      await handle.pool.query(
        `INSERT INTO projects (id, name, slug, is_default, archived, created_at, updated_at)
         VALUES ($1, 'Latest outcomes', $2, false, false, $3, $3)`,
        [projectId, `latest-${projectId}`, "2026-08-11T00:00:00.000Z"],
      );
      await handle.pool.query(
        `INSERT INTO run_batches
           (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
            secret_bindings_json, total_runs, project_id, priority, created_at, updated_at)
         VALUES ($1, $2, 'Latest', 1, 'running', 0, '[]', '[]', 3, $3, 0, $4, $4)`,
        [firstBatchId, `suite-${randomUUID()}`, projectId, "2026-08-11T00:00:00.000Z"],
      );
      await handle.pool.query(
        `INSERT INTO run_batches
           (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
            secret_bindings_json, total_runs, project_id, priority, created_at, updated_at)
         VALUES ($1, $2, 'Latest', 1, 'running', 0, '[]', '[]', 3, $3, 0, $4, $4)`,
        [secondBatchId, `suite-${randomUUID()}`, projectId, "2026-08-12T00:00:00.000Z"],
      );
      await handle.pool.query(
        `INSERT INTO execution_runs
           (id, batch_id, case_definition_id, case_version, display_name, class_name,
            parameters_json, status, terminal_outcome, attempt_count, created_at, updated_at)
         VALUES
           ($1, $2, $3, 1, 'Multi', 'com.example.Multi', '{}',
            'succeeded', 'succeeded', 1, '2026-08-12T01:00:00.000Z', '2026-08-12T01:00:00.000Z'),
           ($4, $5, $3, 1, 'Multi', 'com.example.Multi', '{}',
            'failed', 'timed_out', 1, '2026-08-12T02:00:00.000Z', '2026-08-12T02:00:00.000Z'),
           ($6, $2, $7, 1, 'Stale', 'com.example.Stale', '{}',
            'failed', 'failed', 1, '2026-08-12T01:00:00.000Z', '2026-08-12T01:00:00.000Z'),
           ($8, $5, $7, 1, 'Stale', 'com.example.Stale', '{}',
            'running', NULL, 0, '2026-08-12T03:00:00.000Z', '2026-08-12T03:00:00.000Z'),
           ($9, $5, $10, 1, 'Queued', 'com.example.Queued', '{}',
            'queued', NULL, 0, '2026-08-12T03:00:00.000Z', '2026-08-12T03:00:00.000Z'),
           ($11, $2, $12, 1, 'Cancelled', 'com.example.Cancelled', '{}',
            'cancelled', 'cancelled', 1, '2026-08-12T01:30:00.000Z', '2026-08-12T01:30:00.000Z'),
           ($13, $2, $14, 1, 'Legacy', 'com.example.Legacy', '{}',
            'succeeded', NULL, 1, '2026-08-12T01:15:00.000Z', '2026-08-12T01:15:00.000Z')`,
        [
          randomUUID(),
          firstBatchId,
          caseMulti,
          randomUUID(),
          secondBatchId,
          randomUUID(),
          caseStale,
          randomUUID(),
          randomUUID(),
          caseQueuedOnly,
          randomUUID(),
          caseCancelled,
          randomUUID(),
          caseNullOutcome,
        ],
      );

      // 每用例多条 run：取最新终态 run；最新 run 尚未终态时回退到更早的终态 run；
      // 仅有排队中 run 的用例不返回。
      const outcomes = await catalog.listLatestRunOutcomes([
        caseMulti,
        caseStale,
        caseQueuedOnly,
        caseCancelled,
        caseNullOutcome,
        `${casePrefix}unknown`,
      ]);

      expect(new Map(outcomes.map((entry) => [entry.caseDefinitionId, entry]))).toEqual(
        new Map([
          [
            caseMulti,
            {
              caseDefinitionId: caseMulti,
              outcome: "timed_out",
              executedAt: "2026-08-12T02:00:00.000Z",
            },
          ],
          [
            caseStale,
            {
              caseDefinitionId: caseStale,
              outcome: "failed",
              executedAt: "2026-08-12T01:00:00.000Z",
            },
          ],
          [
            caseCancelled,
            {
              caseDefinitionId: caseCancelled,
              outcome: "cancelled",
              executedAt: "2026-08-12T01:30:00.000Z",
            },
          ],
          [
            caseNullOutcome,
            {
              caseDefinitionId: caseNullOutcome,
              outcome: "succeeded",
              executedAt: "2026-08-12T01:15:00.000Z",
            },
          ],
        ]),
      );
      expect(await catalog.listLatestRunOutcomes([])).toEqual([]);
    } finally {
      await handle.pool.query("DELETE FROM execution_runs WHERE batch_id IN ($1, $2)", [
        firstBatchId,
        secondBatchId,
      ]);
      await handle.pool.query("DELETE FROM run_batches WHERE id IN ($1, $2)", [
        firstBatchId,
        secondBatchId,
      ]);
      await handle.pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
      await handle.close();
    }
  });
});

function postgresTestNgResult() {
  const counts = { total: 1, passed: 1, failed: 0, skipped: 0, configurationFailures: 0 };
  return {
    ...counts,
    detailsTruncated: false,
    suites: [
      {
        ...counts,
        name: "PostgreSQL suite",
        durationMs: 100,
        tests: [
          {
            ...counts,
            name: "PostgreSQL test",
            durationMs: 100,
            classes: [
              {
                ...counts,
                name: "example.PostgresTest",
                durationMs: 100,
                methods: [
                  {
                    name: "passes",
                    status: "passed" as const,
                    configuration: false,
                    durationMs: 100,
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

function postgresCaseCandidate() {
  return {
    className: "example.PostgresSmoke",
    packageName: "example",
    simpleName: "PostgresSmoke",
    enabled: true,
    classLevelTest: false,
    groups: ["smoke"],
    methods: [
      {
        methodName: "smoke",
        descriptor: "()V",
        enabled: true,
        annotationSource: "method" as const,
        groups: ["smoke"],
        dependsOnMethods: [],
        dependsOnGroups: [],
      },
    ],
  };
}

function postgresClassCandidate(className: string, groups: string[]) {
  const simpleName = className.slice(className.lastIndexOf(".") + 1);
  return {
    className,
    packageName: className.slice(0, className.lastIndexOf(".")),
    simpleName,
    enabled: true,
    classLevelTest: false,
    groups,
    methods: [
      {
        methodName: "run",
        descriptor: "()V",
        enabled: true,
        annotationSource: "method" as const,
        groups,
        dependsOnMethods: [],
        dependsOnGroups: [],
      },
    ],
  };
}

async function importPostgresSource(
  catalog: PostgresCaseCatalogRepository,
  sourceId: string,
  sha256: string,
  classes: Array<{ name: string; groups: string[] }>,
): Promise<void> {
  await catalog.importCatalog({
    sourceId,
    objectKey: `jars/${sourceId}/fixture.jar`,
    displayName: `source-${sourceId}`,
    importedAt: "2026-08-09T00:00:00.000Z",
    inspection: {
      schemaVersion: 1,
      fileName: "fixture.jar",
      sha256,
      sizeBytes: 128,
      classFileCount: classes.length,
      testClassCount: classes.length,
      testMethodCount: classes.length,
      hasRootTestNgXml: false,
      discoveryMode: "bytecode-annotations",
      warnings: [],
      classes: classes.map((item) => postgresClassCandidate(item.name, item.groups)),
    },
    cases: classes.map((item, index) => ({
      caseDefinitionId: `${sourceId}-case-${index + 1}`,
      caseVersionId: randomUUID(),
      candidate: postgresClassCandidate(item.name, item.groups),
      methods: [{ methodId: randomUUID(), methodIndex: 0 }],
    })),
  });
}
