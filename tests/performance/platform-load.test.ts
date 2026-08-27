import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { JobEnvelope } from "@autoforge/contracts";
import { scheduleExecutionRuns, type ExecutionRun, type Runner } from "@autoforge/domain";
import {
  createAttemptLogStore,
  createSqliteDatabase,
  SqliteCaseCatalogRepository,
  SqliteCaseSuiteRepository,
  SqliteExecutionControlRepository,
  SqliteRunBatchRepository,
  SqliteRunnerRepository,
} from "@autoforge/db/sqlite";
import { SqliteJobQueue } from "@autoforge/queue/sqlite";
import { TestNgJarDiscovery } from "@autoforge/testng-discovery";
import { zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";

import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";

const temporaryDirectories: string[] = [];
const baselineTimestamp = "2026-08-11T00:00:00.000Z";

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded platform performance baseline", () => {
  it("discovers 2,000 TestNG classes and 10,000 methods within the bounded JAR limits", async () => {
    const entries: Record<string, Uint8Array> = {};
    for (let classIndex = 0; classIndex < 2_000; classIndex += 1) {
      const className = `load.fixture.Test${classIndex}`;
      entries[`load/fixture/Test${classIndex}.class`] = buildClassFile({
        className,
        methods: Array.from({ length: 5 }, (_, methodIndex) => ({
          name: `case${methodIndex}`,
          annotations: [{ type: "Test" as const }],
        })),
      });
    }
    const archive = zipSync(entries, { level: 1 });
    const startedAt = performance.now();
    const inspection = await new TestNgJarDiscovery().inspect("load.jar", archive);
    const durationMs = performance.now() - startedAt;

    expect(inspection.testClassCount).toBe(2_000);
    expect(inspection.testMethodCount).toBe(10_000);
    expect(durationMs).toBeLessThan(30_000);
    recordMetric("jar-discovery", durationMs, {
      archiveBytes: archive.byteLength,
      classes: inspection.testClassCount,
      methods: inspection.testMethodCount,
    });
  });

  it("schedules the bounded window of a 100,000-run task without overselling 1,000 slots", () => {
    const runners = Array.from({ length: 50 }, (_, index) => runnerFixture(index));
    const runs = Array.from({ length: 4_096 }, (_, index) => runFixture(index));
    const startedAt = performance.now();
    const plan = scheduleExecutionRuns({
      runs,
      candidates: runners.map((runner) => ({ runner, reservedSlots: 0 })),
      thresholds: {
        maximumCpuUtilizationPercent: 90,
        maximumMemoryUtilizationPercent: 90,
        maximumLoadPerCpu: 2,
      },
      metricsFreshAfter: "2026-08-10T23:59:00.000Z",
    });
    const durationMs = performance.now() - startedAt;
    const assignmentsByRunner = new Map<string, number>();
    for (const decision of plan.decisions) {
      assignmentsByRunner.set(
        decision.runnerId,
        (assignmentsByRunner.get(decision.runnerId) ?? 0) + 1,
      );
    }

    expect(plan.decisions).toHaveLength(1_000);
    expect(plan.unassignedRunIds).toHaveLength(3_096);
    expect(Math.max(...assignmentsByRunner.values())).toBe(20);
    expect(Math.min(...assignmentsByRunner.values())).toBe(20);
    expect(durationMs).toBeLessThan(2_000);
    recordMetric("scheduler", durationMs, {
      taskRuns: 100_000,
      windowRuns: 4_096,
      runners: 50,
      slots: 1_000,
    });
  });

  it("persists 100,000 execution runs and reads a bounded scheduling window", async () => {
    const directory = await temporaryDirectory("autoforge-run-batch-load-");
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "runs.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../../packages/db/drizzle/sqlite"),
    });
    const repository = new SqliteRunBatchRepository(handle);
    const attemptLogs = createAttemptLogStore(resolve(directory, "attempt-logs"));
    const executionControl = new SqliteExecutionControlRepository(handle, attemptLogs);
    const startedAt = performance.now();
    try {
      const batch = await repository.create({
        id: "batch-100k",
        projectId: "project-load",
        suiteId: "suite-100k",
        suiteName: "100k capacity",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: [],
        runs: Array.from({ length: 100_000 }, (_, index) => ({
          id: `run-${index.toString().padStart(6, "0")}`,
          caseDefinitionId: `case-${index.toString().padStart(6, "0")}`,
          caseVersion: 1,
          displayName: `Case ${index}`,
          className: `load.fixture.Test${index}`,
        })),
        createdAt: baselineTimestamp,
      });
      const snapshot = await repository.getSchedulingSnapshot(batch.id, "2026-08-10T23:59:00.000Z");
      const durationMs = performance.now() - startedAt;

      expect(batch).toMatchObject({ totalRuns: 100_000, queuedRuns: 100_000 });
      expect(snapshot?.queuedRuns).toHaveLength(4_096);
      expect(snapshot?.batch).toMatchObject({ totalRuns: 100_000, queuedRuns: 100_000 });
      expect(durationMs).toBeLessThan(60_000);
      recordMetric("sqlite-run-batch", durationMs, {
        runs: 100_000,
        schedulingWindow: snapshot?.queuedRuns.length ?? 0,
      });

      const detailStartedAt = performance.now();
      const [overview, firstCasePage] = await Promise.all([
        repository.getDetailOverview(batch.id),
        repository.listCasePage({
          batchId: batch.id,
          scope: 1,
          sort: "none",
          direction: "asc",
          offset: 0,
          limit: 50,
        }),
      ]);
      const detailDurationMs = performance.now() - detailStartedAt;
      expect(overview).toMatchObject({
        batch: { totalRuns: 100_000 },
        roundSummaries: [{ round: 1, totalRuns: 100_000, executed: 0 }],
      });
      expect(overview).not.toHaveProperty("runs");
      expect(firstCasePage).toMatchObject({ total: 100_000 });
      expect(firstCasePage?.items).toHaveLength(50);
      expect(detailDurationMs).toBeLessThan(10_000);
      recordMetric("sqlite-run-batch-detail", detailDurationMs, {
        runs: 100_000,
        returnedRows: firstCasePage?.items.length ?? 0,
      });

      const terminationStartedAt = performance.now();
      const cancelledRuns = await executionControl.terminateBatch({
        batchId: batch.id,
        actorId: "performance-test",
        reason: "Capacity gate",
        eventId: "termination-event-100k",
        requestedAt: "2026-08-11T00:01:00.000Z",
      });
      const terminationDurationMs = performance.now() - terminationStartedAt;
      expect(cancelledRuns).toBe(100_000);
      expect((await repository.getSummary(batch.id))?.status).toBe("cancelled");
      expect(terminationDurationMs).toBeLessThan(5_000);
      recordMetric("sqlite-terminate-100k", terminationDurationMs, { runs: cancelledRuns });
    } finally {
      attemptLogs.close();
      handle.close();
    }
  });

  it("reserves 500 concurrent Lite assignments in one bounded scheduling pass", async () => {
    const directory = await temporaryDirectory("autoforge-500-concurrency-");
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "concurrency.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../../packages/db/drizzle/sqlite"),
    });
    const catalog = new SqliteCaseCatalogRepository(handle);
    const runners = new SqliteRunnerRepository(handle);
    const batches = new SqliteRunBatchRepository(handle);
    try {
      const archive = zipSync(
        Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => {
            const className = `load.fixture.ConcurrentTest${index}`;
            return [
              `${className.replaceAll(".", "/")}.class`,
              buildClassFile({
                className,
                methods: [{ name: "executes", annotations: [{ type: "Test" }] }],
              }),
            ];
          }),
        ),
      );
      const inspection = await new TestNgJarDiscovery().inspect("concurrent.jar", archive);
      await catalog.importCatalog({
        sourceId: "source-concurrent",
        objectKey: "jars/concurrent.jar",
        displayName: "Concurrent source",
        importedAt: baselineTimestamp,
        inspection,
        cases: inspection.classes.map((candidate, index) => ({
          caseDefinitionId: `case-concurrent-${index}`,
          caseVersionId: `version-concurrent-${index}`,
          candidate,
          methods: [{ methodId: `method-concurrent-${index}`, methodIndex: 0 }],
        })),
      });
      const selectedRunnerIds: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const runner = runnerFixture(index);
        selectedRunnerIds.push(runner.id);
        await runners.register({
          id: runner.id,
          bootstrapTokenHash: `bootstrap-${index}`,
          credentialHash: `credential-${index}`,
          name: runner.name,
          os: runner.os,
          architecture: runner.architecture,
          agentVersion: runner.agentVersion,
          protocolVersion: runner.protocolVersion,
          labels: runner.labels,
          capabilities: runner.capabilities,
          maxConcurrency: runner.maxConcurrency,
          terminalEnabled: false,
          recordedAt: baselineTimestamp,
        });
        await runners.heartbeat({
          runnerId: runner.id,
          labels: runner.labels,
          capabilities: runner.capabilities,
          maxConcurrency: runner.maxConcurrency,
          busySlots: 0,
          agentVersion: runner.agentVersion,
          terminalEnabled: false,
          resourceSnapshot: runner.resourceSnapshot!,
          recordedAt: baselineTimestamp,
        });
      }
      await batches.create({
        id: "batch-concurrent-500",
        projectId: "project-load",
        suiteId: "suite-concurrent-500",
        suiteName: "500 concurrency",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds: selectedRunnerIds,
        runs: Array.from({ length: 500 }, (_, index) => ({
          id: `concurrent-run-${index}`,
          caseDefinitionId: `case-concurrent-${index}`,
          caseVersion: 1,
          displayName: `Concurrent case ${index}`,
          className: inspection.classes[index]!.className,
        })),
        createdAt: baselineTimestamp,
      });

      const startedAt = performance.now();
      const snapshot = await batches.getSchedulingSnapshot(
        "batch-concurrent-500",
        "2026-08-10T23:59:00.000Z",
        500,
      );
      const thresholds = {
        maximumCpuUtilizationPercent: 90,
        maximumMemoryUtilizationPercent: 90,
        maximumLoadPerCpu: 2,
      };
      const plan = scheduleExecutionRuns({
        runs: snapshot!.queuedRuns,
        candidates: snapshot!.candidates,
        thresholds,
        metricsFreshAfter: "2026-08-10T23:59:00.000Z",
      });
      const reserved = await batches.reserveAssignments({
        batchId: "batch-concurrent-500",
        decisions: plan.decisions.map((decision, index) => ({
          ...decision,
          attemptId: `concurrent-attempt-${index}`,
          assignmentId: `concurrent-assignment-${index}`,
        })),
        thresholds,
        offlineBefore: "2026-08-10T23:59:00.000Z",
        metricsFreshAfter: "2026-08-10T23:59:00.000Z",
        scheduledAt: baselineTimestamp,
        projectMaximumConcurrency: 500,
        eventId: "concurrent-scheduling-event",
      });
      const durationMs = performance.now() - startedAt;

      expect(plan.decisions).toHaveLength(500);
      expect(reserved).toBe(500);
      expect(durationMs).toBeLessThan(5_000);
      recordMetric("sqlite-500-concurrency", durationMs, {
        assignments: reserved,
        runners: selectedRunnerIds.length,
      });
    } finally {
      handle.close();
    }
  });

  it("persists 100,000 cases in one task without a product-level item cap", async () => {
    const directory = await temporaryDirectory("autoforge-case-suite-load-");
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "suite.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../../packages/db/drizzle/sqlite"),
    });
    const repository = new SqliteCaseSuiteRepository(handle);
    handle.client.pragma("foreign_keys = OFF");
    const startedAt = performance.now();
    try {
      await repository.create({
        id: "suite-100k",
        projectId: "project-load",
        name: "100k capacity",
        createdAt: baselineTimestamp,
      });
      const suite = await repository.addCases({
        suiteId: "suite-100k",
        items: Array.from({ length: 100_000 }, (_, index) => ({
          id: `item-${index.toString().padStart(6, "0")}`,
          caseDefinitionId: `case-${index.toString().padStart(6, "0")}`,
        })),
        versionId: "suite-version-2",
        updatedAt: baselineTimestamp,
      });
      const durationMs = performance.now() - startedAt;

      expect(suite).toMatchObject({ caseCount: 100_000, version: 2, revision: 2 });
      expect(durationMs).toBeLessThan(60_000);
      recordMetric("sqlite-case-suite", durationMs, { cases: suite.caseCount });
    } finally {
      handle.client.pragma("foreign_keys = ON");
      handle.close();
    }
  });

  it("drains a 10,000-job SQLite backlog across competing worker connections", async () => {
    const directory = await temporaryDirectory("autoforge-queue-load-");
    const databasePath = resolve(directory, "queue.sqlite");
    const migrationsFolder = resolve(import.meta.dirname, "../../packages/db/drizzle/sqlite");
    const handles = Array.from({ length: 8 }, () =>
      createSqliteDatabase({ databasePath, migrationsFolder }),
    );
    const queues = handles.map((handle) => new SqliteJobQueue(handle));
    const startedAt = performance.now();
    try {
      for (let index = 0; index < 10_000; index += 1) {
        await queues[0]!.publish(jobFixture(index));
      }
      const deliveryIds = new Set<string>();
      for (;;) {
        const claims = await Promise.all(
          queues.map((queue, workerIndex) =>
            queue.claim({
              workerId: `worker-${workerIndex}`,
              now: baselineTimestamp,
              leaseExpiresAt: "2026-08-11T00:05:00.000Z",
              limit: 256,
            }),
          ),
        );
        if (claims.every((claim) => claim.length === 0)) break;
        for (const [workerIndex, workerClaims] of claims.entries()) {
          for (const claim of workerClaims) {
            expect(deliveryIds.has(claim.deliveryId)).toBe(false);
            deliveryIds.add(claim.deliveryId);
            await queues[workerIndex]!.acknowledge({
              workerId: `worker-${workerIndex}`,
              deliveryId: claim.deliveryId,
              acknowledgedAt: "2026-08-11T00:00:01.000Z",
            });
          }
        }
      }
      expect(deliveryIds.size).toBe(10_000);
      expect(await queues[0]!.depth()).toEqual({ available: 0, leased: 0, deadLetter: 0 });

      for (let cycle = 0; cycle < 100; cycle += 1) {
        const index = 10_000 + cycle;
        await queues[0]!.publish(jobFixture(index));
        const [claim] = await queues[0]!.claim({
          workerId: "soak-worker",
          now: "2026-08-11T00:01:00.000Z",
          leaseExpiresAt: "2026-08-11T00:01:01.000Z",
          limit: 1,
        });
        expect(claim).toBeDefined();
        expect(await queues[0]!.recoverExpired("2026-08-11T00:01:02.000Z", 1)).toBe(1);
        const [recovered] = await queues[0]!.claim({
          workerId: "recovery-worker",
          now: "2026-08-11T00:01:02.000Z",
          leaseExpiresAt: "2026-08-11T00:02:00.000Z",
          limit: 1,
        });
        expect(recovered?.deliveryId).toBe(claim?.deliveryId);
        await queues[0]!.acknowledge({
          workerId: "recovery-worker",
          deliveryId: recovered!.deliveryId,
          acknowledgedAt: "2026-08-11T00:01:03.000Z",
        });
      }
      const durationMs = performance.now() - startedAt;
      expect(durationMs).toBeLessThan(60_000);
      recordMetric("sqlite-queue", durationMs, {
        backlog: 10_000,
        competingWorkers: queues.length,
        recoveryCycles: 100,
      });
    } finally {
      handles.forEach((handle) => handle.close());
    }
  });

  it("accepts and pages 20,000 authorized log chunks without unbounded reads", async () => {
    const directory = await temporaryDirectory("autoforge-log-load-");
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "logs.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../../packages/db/drizzle/sqlite"),
    });
    const repository = new SqliteExecutionControlRepository(
      handle,
      createAttemptLogStore(resolve(directory, "attempt-logs")),
    );
    const content = `${"x".repeat(508)}\n`;
    const startedAt = performance.now();
    try {
      seedAuthorizedAttempt(handle.client);
      for (let offset = 0; offset < 20_000; offset += 256) {
        await repository.appendLogChunks({
          runnerId: "runner-load",
          attemptId: "attempt-load",
          leaseTokenHash: "lease-token-hash",
          receivedAt: baselineTimestamp,
          chunks: Array.from({ length: Math.min(256, 20_000 - offset) }, (_, index) => ({
            stream: "stdout" as const,
            sequence: offset + index,
            content,
            recordedAt: baselineTimestamp,
          })),
        });
      }
      let afterSequence = -1;
      let readCount = 0;
      for (;;) {
        const page = await repository.listLogChunks({
          attemptId: "attempt-load",
          stream: "stdout",
          afterSequence,
          limit: 500,
        });
        readCount += page.items.length;
        if (page.nextSequence === undefined) break;
        afterSequence = page.nextSequence;
      }
      const durationMs = performance.now() - startedAt;
      expect(readCount).toBe(20_000);
      expect(durationMs).toBeLessThan(60_000);
      recordMetric("sqlite-logs", durationMs, {
        chunks: 20_000,
        bytes: Buffer.byteLength(content) * 20_000,
        pageSize: 500,
      });
    } finally {
      handle.close();
    }
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function runnerFixture(index: number): Runner {
  return {
    id: `runner-${index.toString().padStart(3, "0")}`,
    name: `Runner ${index}`,
    state: "online",
    os: "linux",
    architecture: index % 2 === 0 ? "amd64" : "arm64",
    agentVersion: "0.2.2",
    protocolVersion: 1,
    labels: ["java", "testng"],
    capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"],
    maxConcurrency: 20,
    busySlots: 0,
    lastSeenAt: baselineTimestamp,
    resourceSnapshot: {
      cpuUtilizationPercent: 20,
      memoryUtilizationPercent: 25,
      loadAverage1m: 2,
      logicalCpuCount: 8,
      observedAt: baselineTimestamp,
    },
    terminalEnabled: false,
    credentialVersion: 1,
    createdAt: baselineTimestamp,
    updatedAt: baselineTimestamp,
  };
}

function runFixture(index: number): ExecutionRun {
  return {
    id: `run-${index}`,
    batchId: "batch-load",
    caseDefinitionId: `case-${index}`,
    caseVersion: 1,
    displayName: `Case ${index}`,
    className: `load.fixture.Test${index}`,
    status: "queued",
    attemptCount: 0,
    version: 1,
    createdAt: baselineTimestamp,
    updatedAt: baselineTimestamp,
  };
}

function jobFixture(index: number): JobEnvelope {
  return {
    schemaVersion: 1,
    messageId: `message-${index}`,
    runId: `run-${index}`,
    attempt: 1,
    createdAt: baselineTimestamp,
    priority: index % 11,
    deduplicationKey: `load:${index}`,
    kind: "dispatch-run",
    payload: { batchId: `batch-${Math.floor(index / 10)}` },
  };
}

function seedAuthorizedAttempt(client: {
  pragma(statement: string): unknown;
  exec(sql: string): unknown;
}): void {
  client.pragma("foreign_keys = OFF");
  client.exec(`
    INSERT INTO run_batches
      (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
       total_runs, project_id, priority, created_at, updated_at)
    VALUES
      ('00000000-0000-4000-8000-0000000b0001', 'suite-load', 'Load', 1, 'running', 0, '[]',
       1, 'project-load', 0, '${baselineTimestamp}', '${baselineTimestamp}');
    INSERT INTO execution_runs
      (id, batch_id, case_definition_id, case_version, display_name, class_name,
       parameters_json, status, attempt_count, created_at, updated_at)
    VALUES
      ('run-load', '00000000-0000-4000-8000-0000000b0001', 'case-load', 1, 'Load',
       'load.fixture.LoadTest', '{}', 'running', 1, '${baselineTimestamp}', '${baselineTimestamp}');
    INSERT INTO run_attempts
      (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at)
    VALUES
      ('attempt-load', 'run-load', 'runner-load', 1, 'running', 1, '${baselineTimestamp}');
    INSERT INTO assignments
      (id, attempt_id, execution_run_id, batch_id, runner_id, status, priority,
       execution_spec_json, available_at, claim_deadline_at, claimed_at, version, created_at,
       updated_at)
    VALUES
      ('assignment-load', 'attempt-load', 'run-load', '00000000-0000-4000-8000-0000000b0001',
       'runner-load', 'claimed', 0,
       '{}', '${baselineTimestamp}', '2026-08-11T01:00:00.000Z', '${baselineTimestamp}', 1,
       '${baselineTimestamp}', '${baselineTimestamp}');
    INSERT INTO assignment_leases
      (id, assignment_id, runner_id, token_hash, token_encrypted, status, version,
       expires_at, renewed_at, created_at)
    VALUES
      ('lease-load', 'assignment-load', 'runner-load', 'lease-token-hash', 'encrypted',
       'active', 1, '2026-08-11T01:00:00.000Z', '${baselineTimestamp}', '${baselineTimestamp}');
  `);
  client.pragma("foreign_keys = ON");
}

function recordMetric(name: string, durationMs: number, scale: Record<string, number>): void {
  process.stdout.write(
    `${JSON.stringify({ metric: name, durationMs: Math.round(durationMs), ...scale })}\n`,
  );
}
