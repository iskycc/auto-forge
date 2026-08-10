import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { scheduleExecutionRuns } from "@autoforge/domain";

import { createPostgresDatabase } from "../src/postgres-database";
import {
  PostgresCaseCatalogRepository,
  PostgresCaseSuiteRepository,
  PostgresRunnerRepository,
} from "../src/postgres-platform-repository";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";
import { PostgresExecutionControlRepository } from "../src/postgres-execution-control";
import { PostgresExecutionEnvironmentRepository } from "../src/postgres-execution-environment";
import { PostgresExecutionSecretRepository } from "../src/postgres-execution-secret";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

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
    const executions = new PostgresExecutionControlRepository(handle);
    const environments = new PostgresExecutionEnvironmentRepository(handle);
    const secrets = new PostgresExecutionSecretRepository(handle);
    const suiteId = randomUUID();
    const runnerId = randomUUID();
    const credentialHash = randomUUID();
    const bootstrapTokenHash = randomUUID();
    const secondProjectId = randomUUID();
    const environmentActorId = randomUUID();
    const environmentId = randomUUID();
    const environmentVersionId = randomUUID();
    const secretId = randomUUID();
    const secretVersionId = randomUUID();
    const secondProjectBatchId = `batch-project-${runnerId}`;
    try {
      await handle.ready;
      await handle.pool.query(
        `INSERT INTO projects (id, name, slug, is_default, archived, created_at, updated_at)
         VALUES ($1, $2, $3, false, false, $4, $4)`,
        [secondProjectId, "Second project", `second-${runnerId}`, "2026-08-09T00:00:00.000Z"],
      );
      await handle.pool.query(
        `INSERT INTO users
         (id, username, normalized_username, display_name, source, status,
          force_password_change, failed_login_attempts, created_at, updated_at, version)
         VALUES ($1, $2, $2, 'Environment Actor', 'local', 'active', false, 0, $3, $3, 1)`,
        [environmentActorId, `environment-${runnerId}`, "2026-08-09T00:00:00.000Z"],
      );
      await expect(
        secrets.create({
          id: secretId,
          versionId: secretVersionId,
          projectId: secondProjectId,
          name: `API token ${runnerId}`,
          normalizedName: `api token ${runnerId}`,
          description: "PostgreSQL secret",
          valueEncrypted: "postgres-ciphertext-v1",
          actorId: environmentActorId,
          recordedAt: "2026-08-09T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({ currentVersion: 1, revision: 1 });
      await expect(
        environments.create({
          id: environmentId,
          versionId: environmentVersionId,
          projectId: secondProjectId,
          name: `Staging ${runnerId}`,
          normalizedName: `staging ${runnerId}`,
          description: "PostgreSQL environment",
          variables: [{ name: "BASE_URL", value: "https://postgres.example.test" }],
          secretBindings: [{ name: "API_TOKEN", secretId }],
          actorId: environmentActorId,
          recordedAt: "2026-08-09T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({ currentVersion: 1, revision: 1 });
      await secrets.rotate({
        secretId,
        versionId: randomUUID(),
        expectedRevision: 1,
        valueEncrypted: "postgres-ciphertext-v2",
        actorId: environmentActorId,
        recordedAt: "2026-08-09T00:00:01.000Z",
      });
      await expect(
        environments.getVersion(environmentVersionId, secondProjectId),
      ).resolves.toMatchObject({ version: { secretBindings: [{ secretVersionId }] } });
      await expect(environments.list([secondProjectId])).resolves.toMatchObject([
        { id: environmentId, projectId: secondProjectId },
      ]);
      await expect(
        environments.getVersion(environmentVersionId, "00000000-0000-7000-8000-000000000001"),
      ).resolves.toBeNull();
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
           authoritative, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'ready', '[]', '{}', false, $7)`,
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
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [secondProjectBatchId]);
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [`batch-${runnerId}`]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [`dependency-${runnerId}`]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [`source-${runnerId}`]);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      await handle.pool.query("DELETE FROM runner_bootstrap_uses WHERE token_hash = $1", [
        bootstrapTokenHash,
      ]);
      await handle.pool.query("DELETE FROM case_suites WHERE id = $1", [suiteId]);
      await handle.pool.query(
        "DELETE FROM execution_environment_versions WHERE environment_id = $1",
        [environmentId],
      );
      await handle.pool.query("DELETE FROM execution_environments WHERE id = $1", [environmentId]);
      await handle.pool.query("DELETE FROM execution_secret_versions WHERE secret_id = $1", [
        secretId,
      ]);
      await handle.pool.query("DELETE FROM execution_secrets WHERE id = $1", [secretId]);
      await handle.pool.query("DELETE FROM users WHERE id = $1", [environmentActorId]);
      await handle.pool.query("DELETE FROM projects WHERE id = $1", [secondProjectId]);
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
