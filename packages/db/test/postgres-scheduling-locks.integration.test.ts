import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ReserveSchedulingAssignmentsInput } from "@autoforge/application";
import { REQUIRED_EXECUTION_LABELS } from "@autoforge/domain";
import { createPostgresDatabase, type PostgresDatabaseHandle } from "../src/postgres-database";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";
import { PostgresExecutionControlRepository } from "../src/postgres-execution-control";
import { createAttemptLogStore } from "../src/attempt-log-store";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-11-13T13:00:00.000Z";
const capabilities = ["executor:testng-v1", "isolation:cgroup-v2", "java:21.0.8", "testng:7.11.0"];

describe.skipIf(!connectionString)("PostgreSQL scheduling lock isolation", () => {
  const schema = `scheduling_locks_${randomUUID().replaceAll("-", "")}`;
  let administration: Pool;
  let handle: PostgresDatabaseHandle;
  let scopedUrl: string;
  let logDirectory: string;
  let logs: ReturnType<typeof createAttemptLogStore>;

  beforeAll(async () => {
    administration = new Pool({ connectionString, max: 1 });
    await administration.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    scopedUrl = url.toString();
    handle = createHandle();
    await handle.ready;
    logDirectory = await mkdtemp(resolve(tmpdir(), "autoforge-scheduling-locks-"));
    logs = createAttemptLogStore(logDirectory);
  });

  afterAll(async () => {
    logs?.close();
    if (logDirectory) await rm(logDirectory, { recursive: true, force: true });
    await handle?.close();
    try {
      await administration?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await administration?.end();
    }
  });

  function createHandle(lockTimeoutMs = 30) {
    return createPostgresDatabase({
      connectionString: scopedUrl,
      migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      poolMax: 6,
      lockTimeoutMs,
    });
  }

  it.each(["project", "batch"] as const)(
    "reserves slots while an independent transaction references the %s",
    async (scope) => {
      const fixture = await seed(1, 1);
      await withReferenceLock(scope, fixture, async () => {
        await expect(
          fixture.batches.reserveAssignments(fixture.reservation(0)),
        ).resolves.toMatchObject({ reserved: 1 });
      });
    },
  );

  it.each(["claim", "pause", "terminate", "complete"] as const)(
    "allows %s while history or statistics holds a foreign-key reference to the batch",
    async (action) => {
      const fixture = await seed(1, 1);
      const executions = new PostgresExecutionControlRepository(handle, logs);
      const tokenHash = randomUUID();
      const claim = () =>
        executions.claim({
          runnerId: fixture.runnerIds[0]!,
          requestId: randomUUID(),
          availableSlots: 1,
          labels: [...REQUIRED_EXECUTION_LABELS],
          capabilities,
          now,
          leaseExpiresAt: "2026-11-13T13:01:00.000Z",
          leaseSeeds: [
            {
              id: randomUUID(),
              eventId: randomUUID(),
              tokenHash,
              tokenEncrypted: "fixture-encrypted",
            },
          ],
        });
      let completion: Parameters<typeof executions.completeAttempt>[0] | undefined;
      const reservation = fixture.reservation(0);
      if (action === "complete" || action === "claim") {
        await fixture.batches.reserveAssignments(reservation);
      }
      if (action === "complete") {
        const claims = await claim();
        expect(claims).toHaveLength(1);
        completion = {
          runnerId: fixture.runnerIds[0]!,
          attemptId: reservation.decisions[0]!.attemptId,
          completionId: randomUUID(),
          leaseTokenHash: tokenHash,
          resultDigest: "fixture-result",
          eventId: randomUUID(),
          acceptedAt: now,
          result: {
            status: "succeeded",
            resultCode: "TESTNG_SUCCEEDED",
            summary: "passed",
            durationMs: 1,
            artifacts: [],
          },
        };
      }
      await withReferenceLock("batch", fixture, async () => {
        if (action === "claim") {
          await expect(claim()).resolves.toHaveLength(1);
        } else if (action === "pause") {
          await expect(
            executions.changeBatchScheduling({
              batchId: fixture.batchIds[0]!,
              action: "pause",
              actorId: "fixture-operator",
              requestedAt: now,
              eventId: randomUUID(),
            }),
          ).resolves.toBe(true);
        } else if (action === "terminate") {
          await executions.terminateBatch({
            batchId: fixture.batchIds[0]!,
            actorId: "fixture-operator",
            reason: "operator stopped",
            requestedAt: now,
            eventId: randomUUID(),
          });
          expect((await fixture.batches.getMetadata(fixture.batchIds[0]!))?.status).toBe(
            "cancelled",
          );
        } else {
          await expect(executions.completeAttempt(completion!)).resolves.toMatchObject({
            disposition: "accepted",
            batchClosed: true,
          });
          expect((await fixture.batches.getMetadata(fixture.batchIds[0]!))?.status).toBe(
            "succeeded",
          );
        }
      });
    },
  );

  it.each(["complete", "begin-upload", "cancel"] as const)(
    "allows %s while previous-round analytics retains a foreign-key reference to the same run",
    async (operation) => {
      const fixture = await seed(1, 1);
      const executions = new PostgresExecutionControlRepository(handle, logs);
      const batchId = fixture.batchIds[0]!;
      const runnerId = fixture.runnerIds[0]!;
      await handle.pool.query("UPDATE run_batches SET retry_limit=1 WHERE id=$1", [batchId]);
      const start = async () => {
        const reservation = fixture.reservation(0);
        await fixture.batches.reserveAssignments(reservation);
        const tokenHash = randomUUID();
        const claims = await executions.claim({
          runnerId,
          requestId: randomUUID(),
          availableSlots: 1,
          labels: [...REQUIRED_EXECUTION_LABELS],
          capabilities,
          now,
          leaseExpiresAt: "2026-11-13T13:01:00.000Z",
          leaseSeeds: [
            {
              id: randomUUID(),
              eventId: randomUUID(),
              tokenHash,
              tokenEncrypted: "fixture-encrypted",
            },
          ],
        });
        expect(claims).toHaveLength(1);
        return {
          attemptId: reservation.decisions[0]!.attemptId,
          runId: reservation.decisions[0]!.executionRunId,
          tokenHash,
        };
      };
      const completion = (
        attempt: Awaited<ReturnType<typeof start>>,
        status: "failed" | "succeeded",
      ) => ({
        runnerId,
        attemptId: attempt.attemptId,
        leaseTokenHash: attempt.tokenHash,
        completionId: randomUUID(),
        resultDigest: randomUUID(),
        eventId: randomUUID(),
        acceptedAt: now,
        result: {
          status,
          resultCode: status === "failed" ? "TESTNG_ASSERTIONS_FAILED" : "TESTNG_SUCCEEDED",
          summary: "round result",
          durationMs: 1,
          artifacts: [],
        },
      });
      const previous = await start();
      await expect(
        executions.completeAttempt(completion(previous, "failed")),
      ).resolves.toMatchObject({ retryScheduled: true });
      const current = await start();
      const publisher = await handle.pool.connect();
      try {
        await publisher.query("BEGIN");
        // A real fact for the finished attempt still references the same mutable
        // ExecutionRun now used by the retry. This must not block its control path.
        await publisher.query(
          `INSERT INTO analytics_facts
          (attempt_id,project_id,batch_id,run_id,suite_id,case_definition_id,case_version,runner_id,outcome,completed_at)
          SELECT a.id,b.project_id,b.id,r.id,b.suite_id,r.case_definition_id,r.case_version,a.runner_id,a.outcome,a.finished_at
          FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id JOIN run_batches b ON b.id=r.batch_id WHERE a.id=$1`,
          [previous.attemptId],
        );
        if (operation === "complete") {
          await expect(
            executions.completeAttempt(completion(current, "succeeded")),
          ).resolves.toMatchObject({ disposition: "accepted" });
        } else if (operation === "begin-upload") {
          await expect(
            executions.beginAttemptUpload({
              runnerId,
              attemptId: current.attemptId,
              leaseTokenHash: current.tokenHash,
              startedAt: now,
            }),
          ).resolves.toBeUndefined();
        } else {
          await expect(
            executions.cancelRun({
              runId: current.runId,
              actorId: "fixture-operator",
              reason: "operator stop",
              requestedAt: now,
              eventId: randomUUID(),
            }),
          ).resolves.toBe(true);
        }
      } finally {
        await publisher.query("ROLLBACK");
        publisher.release();
      }
    },
  );

  it("does not hold a batch hostage while waiting for another task's project quota lock", async () => {
    const fixture = await seed(1, 1);
    const schedulerHandle = createHandle(3_000);
    await schedulerHandle.ready;
    const holder = await handle.pool.connect();
    let scheduling: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await holder.query("SELECT id FROM projects WHERE id=$1 FOR NO KEY UPDATE", [
        fixture.projectId,
      ]);
      scheduling = new PostgresRunBatchRepository(schedulerHandle).reserveAssignments(
        fixture.reservation(0),
      );
      // Observe the actual database wait, rather than assuming the scheduler has
      // reached its lock request after a wall-clock delay.
      await expect
        .poll(
          async () =>
            (
              await handle.pool.query(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting",
                [holderPid],
              )
            ).rows[0].waiting,
          { timeout: 1_000 },
        )
        .toBe(true);
      const executions = new PostgresExecutionControlRepository(handle, logs);
      await expect(
        executions.changeBatchScheduling({
          batchId: fixture.batchIds[0]!,
          action: "pause",
          actorId: "fixture-operator",
          requestedAt: now,
          eventId: randomUUID(),
        }),
      ).resolves.toBe(true);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      try {
        if (scheduling) await scheduling;
      } finally {
        await schedulerHandle.close();
      }
    }
    expect((await fixture.batches.getSummary(fixture.batchIds[0]!))?.assignedRuns).toBe(0);
  });

  it("keeps four independent schedulers within project and Runner capacity", async () => {
    const peers = [createHandle(), createHandle()];
    try {
      await Promise.all(peers.map((peer) => peer.ready));
      const fixture = await seed(4, 32);
      const repositories = [
        fixture.batches,
        ...peers.map((peer) => new PostgresRunBatchRepository(peer)),
      ];
      const reservations = await Promise.all(
        fixture.batchIds.map((_, index) =>
          repositories[index % repositories.length]!.reserveAssignments(fixture.reservation(index)),
        ),
      );
      expect(reservations.reduce((sum, result) => sum + result.reserved, 0)).toBe(90);
      const counts = await handle.pool.query<{ runner_id: string; total: string }>(
        "SELECT a.runner_id,COUNT(*) AS total FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id JOIN run_batches b ON b.id=r.batch_id WHERE b.project_id=$1 AND a.status='assigned' GROUP BY a.runner_id",
        [fixture.projectId],
      );
      expect(counts.rows).toHaveLength(2);
      expect(counts.rows.every((row) => Number(row.total) <= 50)).toBe(true);
      expect(new Set(reservations.flatMap((result) => result.acceptedAttemptIds)).size).toBe(90);

      const executionRepositories = [handle, ...peers].map(
        (peer) => new PostgresExecutionControlRepository(peer, logs),
      );
      const leaseTokenHashes = new Map<string, string>();
      const claims = (
        await Promise.all(
          fixture.runnerIds.map((runnerId, index) =>
            executionRepositories[index]!.claim({
              runnerId,
              requestId: randomUUID(),
              availableSlots: 50,
              labels: [...REQUIRED_EXECUTION_LABELS],
              capabilities,
              now,
              leaseExpiresAt: "2026-11-13T13:01:00.000Z",
              leaseSeeds: Array.from({ length: 50 }, () => {
                const id = randomUUID();
                const tokenHash = randomUUID();
                leaseTokenHashes.set(id, tokenHash);
                return {
                  id,
                  eventId: randomUUID(),
                  tokenHash,
                  tokenEncrypted: "fixture-encrypted",
                };
              }),
            }),
          ),
        )
      ).flat();
      expect(claims).toHaveLength(90);
      await Promise.all(
        claims.map((claim, index) =>
          executionRepositories[index % executionRepositories.length]!.renewLease({
            runnerId: claim.assignment.runnerId,
            leaseId: claim.lease.id,
            tokenHash: leaseTokenHashes.get(claim.lease.id)!,
            expectedVersion: 1,
            now: "2026-11-13T13:00:30.000Z",
            expiresAt: "2026-11-13T13:02:00.000Z",
          }),
        ),
      );
      const recovered = await executionRepositories[0]!.recoverExpired({
        now: "2026-11-13T13:01:30.000Z",
        eventIds: Array.from({ length: 100 }, () => randomUUID()),
        limit: 100,
      });
      const claimedAttemptIds = new Set(claims.map((claim) => claim.assignment.attemptId));
      expect(recovered.filter((attempt) => claimedAttemptIds.has(attempt.attemptId))).toEqual([]);

      const completions = await Promise.all(
        claims.map((claim, index) =>
          executionRepositories[index % executionRepositories.length]!.completeAttempt({
            runnerId: claim.assignment.runnerId,
            attemptId: claim.assignment.attemptId,
            completionId: randomUUID(),
            resultDigest: `completed-${claim.assignment.attemptId}`,
            leaseTokenHash: leaseTokenHashes.get(claim.lease.id)!,
            eventId: randomUUID(),
            acceptedAt: "2026-11-13T13:01:31.000Z",
            result: {
              status: "succeeded",
              resultCode: "TESTNG_SUCCEEDED",
              summary: "passed",
              durationMs: 91_000,
              artifacts: [],
            },
          }),
        ),
      );
      // A post-commit settlement retry legitimately returns its durable receipt.
      expect(
        completions.every((response) => ["accepted", "duplicate"].includes(response.disposition)),
      ).toBe(true);
      const receipts = await handle.pool.query<{ total: string }>(
        "SELECT COUNT(*) AS total FROM attempt_completion_receipts c JOIN run_attempts a ON a.id=c.attempt_id JOIN execution_runs r ON r.id=a.execution_run_id JOIN run_batches b ON b.id=r.batch_id WHERE b.project_id=$1",
        [fixture.projectId],
      );
      expect(Number(receipts.rows[0]!.total)).toBe(90);
      const runCounts = await handle.pool.query<{ status: string; total: string }>(
        "SELECT r.status,COUNT(*) AS total FROM execution_runs r JOIN run_batches b ON b.id=r.batch_id WHERE b.project_id=$1 GROUP BY r.status",
        [fixture.projectId],
      );
      expect(
        Object.fromEntries(runCounts.rows.map((row) => [row.status, Number(row.total)])),
      ).toEqual({ succeeded: 90, queued: 38 });

      const pending = (
        await Promise.all(fixture.batchIds.map((id) => fixture.batches.getSummary(id)))
      ).flatMap((batch, index) => (batch && batch.queuedRuns > 0 ? [index] : []));
      const refill = await Promise.all(
        pending.map((index) =>
          repositories[index % repositories.length]!.reserveAssignments(fixture.reservation(index)),
        ),
      );
      expect(refill.reduce((sum, result) => sum + result.reserved, 0)).toBe(38);
    } finally {
      await Promise.all(peers.map((peer) => peer.close()));
    }
  });

  it.each(["result", "settlement"] as const)(
    "recovers transient completion lock failure during %s without publishing a result twice",
    async (phase) => {
      const fixture = await seed(1, 1);
      const executions = new PostgresExecutionControlRepository(handle, logs);
      const reservation = fixture.reservation(0);
      await fixture.batches.reserveAssignments(reservation);
      const tokenHash = randomUUID();
      await executions.claim({
        runnerId: fixture.runnerIds[0]!,
        requestId: randomUUID(),
        availableSlots: 1,
        labels: [...REQUIRED_EXECUTION_LABELS],
        capabilities,
        now,
        leaseExpiresAt: "2026-11-13T13:01:00.000Z",
        leaseSeeds: [
          {
            id: randomUUID(),
            eventId: randomUUID(),
            tokenHash,
            tokenEncrypted: "fixture-encrypted",
          },
        ],
      });
      const fault = `completion_lock_${randomUUID().replaceAll("-", "")}`;
      const table = phase === "result" ? "assignments" : "run_batches";
      const targetId =
        phase === "result" ? reservation.decisions[0]!.assignmentId : fixture.batchIds[0]!;
      const terminal = phase === "result" ? "completed" : "succeeded";
      try {
        // Sequences are not rolled back: inject exactly one real PostgreSQL
        // lock error, then allow recovery without depending on timing races.
        await handle.pool.query(`CREATE SEQUENCE ${fault};
          CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.id='${targetId}' AND NEW.status='${terminal}' AND nextval('${fault}')=1 THEN
              RAISE EXCEPTION 'injected completion lock contention' USING ERRCODE='55P03';
            END IF; RETURN NEW; END $$;
          CREATE TRIGGER ${fault} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fault}()`);
        const input = {
          runnerId: fixture.runnerIds[0]!,
          attemptId: reservation.decisions[0]!.attemptId,
          completionId: randomUUID(),
          resultDigest: "transient-lock-result",
          leaseTokenHash: tokenHash,
          eventId: randomUUID(),
          acceptedAt: now,
          result: {
            status: "succeeded" as const,
            resultCode: "TESTNG_SUCCEEDED",
            summary: "passed",
            durationMs: 1,
            artifacts: [],
          },
        };
        await expect(executions.completeAttempt(input)).resolves.toMatchObject({
          disposition: phase === "result" ? "accepted" : "duplicate",
          batchClosed: true,
        });
        expect((await fixture.batches.getMetadata(fixture.batchIds[0]!))?.status).toBe("succeeded");
        expect(
          (
            await handle.pool.query(
              "SELECT COUNT(*) AS total FROM attempt_completion_receipts WHERE attempt_id=$1",
              [input.attemptId],
            )
          ).rows[0].total,
        ).toBe("1");
        expect(
          (
            await handle.pool.query(
              "SELECT COUNT(*) AS total FROM attempt_state_events WHERE attempt_id=$1 AND event_type='attempt.completed'",
              [input.attemptId],
            )
          ).rows[0].total,
        ).toBe("1");
      } finally {
        await handle.pool.query(
          `DROP FUNCTION IF EXISTS ${fault}() CASCADE; DROP SEQUENCE IF EXISTS ${fault}`,
        );
      }
    },
  );

  async function withReferenceLock(
    scope: "project" | "batch",
    fixture: Awaited<ReturnType<typeof seed>>,
    operation: () => Promise<void>,
  ) {
    const holder = await handle.pool.connect();
    try {
      await holder.query("BEGIN");
      if (scope === "project") {
        // A real foreign-key insert, as performed by audit and snapshot writers.
        await holder.query(
          "INSERT INTO project_versions(id,project_id,name,normalized_name,created_at,updated_at) VALUES ($1,$2,'pending version','pending version',$3,$3)",
          [randomUUID(), fixture.projectId, now],
        );
      } else {
        await holder.query(
          "INSERT INTO run_batch_status_events(id,batch_id,from_status,to_status,batch_version,reason,recorded_at) VALUES ($1,$2,NULL,'queued',1,'uncommitted history',$3)",
          [randomUUID(), fixture.batchIds[0], now],
        );
      }
      await operation();
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }

  async function seed(batchCount: number, runsPerBatch: number) {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const runnerIds = [randomUUID(), randomUUID()];
    await handle.pool.query(
      "INSERT INTO projects(id,name,slug,is_default,archived,created_at,updated_at) VALUES ($1,'Scheduling locks',$1,FALSE,FALSE,$2,$2)",
      [projectId, now],
    );
    await handle.pool.query(
      "INSERT INTO case_sources(id,project_id,display_name,original_file_name,object_key,sha256,size_bytes,class_count,method_count,status,warnings_json,inspection_json,created_at,updated_at) VALUES ($1,$2,'fixture','fixture.jar',$1,$3,100,$4,$4,'ready','[]','{}',$5,$5)",
      [sourceId, projectId, "a".repeat(64), runsPerBatch, now],
    );
    const caseIds = Array.from({ length: runsPerBatch }, () => randomUUID());
    for (const [index, caseId] of caseIds.entries()) {
      await handle.pool.query(
        "INSERT INTO case_definitions(id,project_id,source_id,class_name,package_name,display_name,enabled,groups_json,current_version,created_at,updated_at) VALUES ($1,$2,$3,$4,'fixture',$4,TRUE,'[]',1,$5,$5)",
        [caseId, projectId, sourceId, `fixture.Case${index}`, now],
      );
      await handle.pool.query(
        "INSERT INTO case_versions(id,case_definition_id,source_id,version,snapshot_json,created_at) VALUES ($1,$2,$3,1,'{}',$4)",
        [randomUUID(), caseId, sourceId, now],
      );
    }
    for (const runnerId of runnerIds) {
      await handle.pool.query(
        "INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,cpu_utilization_percent,memory_utilization_percent,load_average_1m,logical_cpu_count,metrics_observed_at,last_seen_at,created_at,updated_at) VALUES ($1,$1,$1,'linux','amd64','1.22.17',1,'[]',$2,50,0,10,20,0,16,$3,$3,$3,$3)",
        [runnerId, JSON.stringify(capabilities), now],
      );
    }
    const batchIds = Array.from({ length: batchCount }, () => randomUUID());
    const runIds = batchIds.map(() => caseIds.map(() => randomUUID()));
    const batches = new PostgresRunBatchRepository(handle);
    for (const [index, batchId] of batchIds.entries()) {
      await batches.create({
        id: batchId,
        projectId,
        suiteId: randomUUID(),
        suiteName: "Scheduling locks",
        suiteVersion: 1,
        retryLimit: 0,
        environmentVariables: [],
        runnerIds,
        policy: { executor: "testng", concurrency: 40, runnerLabels: [], artifactPatterns: [] },
        runs: caseIds.map((caseId, caseIndex) => ({
          id: runIds[index]![caseIndex]!,
          caseDefinitionId: caseId,
          caseVersion: 1,
          displayName: `Case${caseIndex}`,
          className: `fixture.Case${caseIndex}`,
        })),
        createdAt: now,
      });
    }
    return {
      projectId,
      runnerIds,
      batchIds,
      batches,
      reservation(index: number): ReserveSchedulingAssignmentsInput {
        return {
          batchId: batchIds[index]!,
          expectedCurrentRound: 1,
          eventId: randomUUID(),
          projectMaximumConcurrency: 90,
          decisions: runIds[index]!.map((runId, runIndex) => ({
            executionRunId: runId,
            runnerId: runnerIds[runIndex % 2]!,
            score: 1,
            attemptId: randomUUID(),
            assignmentId: randomUUID(),
          })),
          thresholds: {
            maximumCpuUtilizationPercent: 80,
            maximumMemoryUtilizationPercent: 85,
            maximumLoadPerCpu: 1,
          },
          offlineBefore: "2026-11-13T12:59:00.000Z",
          metricsFreshAfter: "2026-11-13T12:59:00.000Z",
          scheduledAt: now,
        };
      },
    };
  }
});
