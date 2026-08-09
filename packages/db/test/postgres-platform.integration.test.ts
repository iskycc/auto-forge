import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { scheduleExecutionRuns } from "@autoforge/domain";

import { createPostgresDatabase } from "../src/postgres-database";
import {
  PostgresCaseSuiteRepository,
  PostgresRunnerRepository,
} from "../src/postgres-platform-repository";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)("PostgreSQL platform repositories", () => {
  it("applies migrations and persists suites and runner heartbeats", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    const suites = new PostgresCaseSuiteRepository(handle);
    const runners = new PostgresRunnerRepository(handle);
    const batches = new PostgresRunBatchRepository(handle);
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
          maxConcurrency: 1,
          terminalEnabled: false,
          recordedAt: "2026-08-09T00:00:00.000Z",
        }),
      ).resolves.toBeNull();
      const heartbeat = await runners.heartbeat({
        runnerId,
        labels: ["java", "testng"],
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
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [`batch-${runnerId}`]);
      await handle.pool.query("DELETE FROM runners WHERE id = $1", [runnerId]);
      await handle.pool.query("DELETE FROM runner_bootstrap_uses WHERE token_hash = $1", [
        bootstrapTokenHash,
      ]);
      await handle.pool.query("DELETE FROM case_suites WHERE id = $1", [suiteId]);
      await handle.close();
    }
  });
});
