import { mkdtempSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createPostgresDatabase } from "../src/postgres-database";
import {
  PostgresCaseCatalogRepository,
  PostgresRunnerRepository,
} from "../src/postgres-platform-repository";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";
import { PostgresExecutionControlRepository } from "../src/postgres-execution-control";
import { createAttemptLogStore, type AttemptLogStore } from "../src/attempt-log-store";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

function createTestAttemptLogs(): { store: AttemptLogStore; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "autoforge-pg-concurrent-logs-"));
  return { store: createAttemptLogStore(directory), directory };
}

function cleanupTestAttemptLogs(logs: { store: AttemptLogStore; directory: string }): void {
  logs.store.close();
  rmSync(logs.directory, { recursive: true, force: true });
}

const RUN_COUNT = 16;

describe.skipIf(!connectionString)("PostgreSQL concurrent attempt completions", () => {
  it("reaches the terminal batch status when all remaining attempts complete at once", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const catalog = new PostgresCaseCatalogRepository(handle);
    const runners = new PostgresRunnerRepository(handle);
    const batches = new PostgresRunBatchRepository(handle);
    const attemptLogs = createTestAttemptLogs();
    const executions = new PostgresExecutionControlRepository(handle, attemptLogs.store);
    const suffix = randomUUID();
    const sourceId = `source-concurrent-${suffix}`;
    const caseDefinitionId = `case-concurrent-${suffix}`;
    const runnerId = `runner-concurrent-${suffix}`;
    const batchId = `batch-concurrent-${suffix}`;
    const now = "2026-08-09T00:00:00.000Z";
    const thresholds = {
      maximumCpuUtilizationPercent: 80,
      maximumMemoryUtilizationPercent: 85,
      maximumLoadPerCpu: 1,
    };
    try {
      await handle.ready;
      // 批次内 (batch_id, case_definition_id) 唯一，需为每个 run 提供独立用例。
      const candidates = Array.from({ length: RUN_COUNT }, (_, index) => {
        const simpleName = `ConcurrentSmoke${index}X${suffix.slice(0, 8)}`;
        return {
          className: `example.${simpleName}`,
          packageName: "example",
          simpleName,
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
      });
      await catalog.importCatalog({
        sourceId,
        objectKey: `jars/${sourceId}/concurrent.jar`,
        displayName: "Concurrent source",
        importedAt: now,
        inspection: {
          schemaVersion: 1,
          fileName: "concurrent.jar",
          sha256: createHash("sha256").update(suffix).digest("hex"),
          sizeBytes: 128,
          classFileCount: RUN_COUNT,
          testClassCount: RUN_COUNT,
          testMethodCount: RUN_COUNT,
          hasRootTestNgXml: false,
          discoveryMode: "bytecode-annotations",
          warnings: [],
          classes: candidates,
        },
        cases: candidates.map((candidate, index) => ({
          caseDefinitionId: `${caseDefinitionId}-${index}`,
          caseVersionId: randomUUID(),
          candidate,
          methods: [{ methodId: randomUUID(), methodIndex: 0 }],
        })),
      });
      await runners.register({
        id: runnerId,
        bootstrapTokenHash: randomUUID(),
        credentialHash: randomUUID(),
        name: "concurrent-runner",
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.0",
        protocolVersion: 1,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: RUN_COUNT,
        terminalEnabled: false,
        recordedAt: now,
      });
      await runners.heartbeat({
        runnerId,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        maxConcurrency: RUN_COUNT,
        busySlots: 0,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        resourceSnapshot: {
          cpuUtilizationPercent: 10,
          memoryUtilizationPercent: 20,
          loadAverage1m: 0.1,
          logicalCpuCount: 4,
          observedAt: "2026-08-09T00:01:00.000Z",
        },
        recordedAt: "2026-08-09T00:01:00.000Z",
      });
      const runs = Array.from({ length: RUN_COUNT }, (_, index) => ({
        id: `run-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
        caseDefinitionId: `${caseDefinitionId}-${index}`,
        caseVersion: 1,
        displayName: `Concurrent ${index}`,
        className: candidates[index]!.className,
      }));
      await batches.create({
        id: batchId,
        suiteId: randomUUID(),
        suiteName: "Concurrent completions",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: [runnerId],
        policy: {
          executor: "testng",
          concurrency: RUN_COUNT,
          runnerLabels: [],
          artifactPatterns: [],
        },
        runs,
        createdAt: "2026-08-09T00:01:00.000Z",
      });
      const reservation = await batches.reserveAssignments({
        batchId,
        decisions: runs.map((run, index) => ({
          executionRunId: run.id,
          runnerId,
          score: 1,
          attemptId: `attempt-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
          assignmentId: `assignment-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
        })),
        thresholds,
        offlineBefore: "2026-08-09T00:00:30.000Z",
        metricsFreshAfter: "2026-08-09T00:00:30.000Z",
        scheduledAt: "2026-08-09T00:01:01.000Z",
      });
      expect(reservation.reserved).toBe(RUN_COUNT);
      expect(reservation.acceptedAttemptIds).toHaveLength(RUN_COUNT);
      await executions.claim({
        runnerId,
        requestId: `claim-concurrent-${suffix}`,
        availableSlots: RUN_COUNT,
        labels: ["java", "testng"],
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
        leaseSeeds: runs.map((_, index) => ({
          id: `lease-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
          eventId: `event-claim-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
          tokenHash: `lease-token-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
          tokenEncrypted: `encrypted-lease-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
        })),
        now: "2026-08-09T00:01:02.000Z",
        leaseExpiresAt: "2026-08-09T00:05:00.000Z",
      });

      // 所有剩余 attempt 同时完成。旧实现的无锁预聚合会让最后两个事务
      // 各自看到对方未提交的 running 态，终态迁移丢失，批次永久卡死。
      const completions = await Promise.all(
        runs.map((_, index) =>
          executions.completeAttempt({
            runnerId,
            attemptId: `attempt-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
            completionId: `completion-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
            leaseTokenHash: `lease-token-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
            resultDigest: `digest-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
            result: {
              status: "succeeded",
              resultCode: "PASSED",
              summary: "passed",
              durationMs: 100,
              artifacts: [],
            },
            eventId: `event-complete-concurrent-${String(index).padStart(2, "0")}-${suffix}`,
            acceptedAt: "2026-08-09T00:01:30.000Z",
          }),
        ),
      );
      expect(completions.map((completion) => completion.disposition)).toEqual(
        Array.from({ length: RUN_COUNT }, () => "accepted"),
      );

      const batch = await batches.get(batchId);
      expect(batch?.status).toBe("succeeded");
      const terminalEvent = await handle.pool.query<{ to_status: string }>(
        "SELECT to_status FROM run_batch_status_events WHERE batch_id = $1 ORDER BY recorded_at",
        [batchId],
      );
      expect(terminalEvent.rows.map((row) => row.to_status)).toContain("succeeded");
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [batchId]);
      await handle.pool.query(
        "DELETE FROM case_versions WHERE source_id = $1 OR case_definition_id IN (SELECT id FROM case_definitions WHERE class_name LIKE $2)",
        [sourceId, `%${suffix.slice(0, 8)}`],
      );
      await handle.pool.query("DELETE FROM case_definitions WHERE class_name LIKE $1", [
        `%${suffix.slice(0, 8)}`,
      ]);
      await handle.pool.query("DELETE FROM case_sources WHERE id = $1", [sourceId]);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      cleanupTestAttemptLogs(attemptLogs);
      await handle.close();
    }
  }, 60_000);
});
