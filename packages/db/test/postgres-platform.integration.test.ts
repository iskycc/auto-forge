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
    const suiteId = randomUUID();
    const runnerId = randomUUID();
    const credentialHash = randomUUID();
    const bootstrapTokenHash = randomUUID();
    try {
      await handle.ready;
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
        capabilities: ["executor:testng-v1", "java:21", "testng:7.11.0"],
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
      });
      const claimed = await executions.claim({
        runnerId,
        requestId: `claim-${runnerId}`,
        availableSlots: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1"],
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
            artifacts: [],
          },
          eventId: `complete-event-${runnerId}`,
          acceptedAt: "2026-08-09T00:01:20.000Z",
        }),
      ).resolves.toMatchObject({ disposition: "accepted", retryScheduled: false });
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [`batch-${runnerId}`]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [`source-${runnerId}`]);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      await handle.pool.query("DELETE FROM runner_bootstrap_uses WHERE token_hash = $1", [
        bootstrapTokenHash,
      ]);
      await handle.pool.query("DELETE FROM case_suites WHERE id = $1", [suiteId]);
      await handle.close();
    }
  });
});

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
