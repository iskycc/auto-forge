import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase, type SqliteDatabaseHandle } from "../src/database";
import { SqliteRoundRecoveryRepository } from "../src/sqlite-round-recovery";

const createdAt = "2026-08-23T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SqliteRoundRecoveryRepository", () => {
  it("does not request the SQLite writer lock when no recovery is due", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-round-recovery-idle-"));
    directories.push(directory);
    const options = {
      databasePath: resolve(directory, "autoforge.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    };
    const writer = createSqliteDatabase(options);
    const poller = createSqliteDatabase(options);
    writer.client.exec("BEGIN IMMEDIATE");
    try {
      const repository = new SqliteRoundRecoveryRepository(poller);
      await expect(
        repository.claimDue({
          workerId: "idle-worker",
          now: createdAt,
          leaseExpiresAt: "2026-08-23T00:00:30.000Z",
          limit: 10,
        }),
      ).resolves.toEqual([]);
    } finally {
      writer.client.exec("ROLLBACK");
      writer.close();
      poller.close();
    }
  });

  it("leases a due recovery and atomically releases the held next round after waiting", async () => {
    const handle = await database();
    seedRecovery(handle, "batch-1", "pending");
    const repository = new SqliteRoundRecoveryRepository(handle);

    const [triggerClaim] = await repository.claimDue({
      workerId: "worker-1",
      now: createdAt,
      leaseExpiresAt: "2026-08-23T00:00:30.000Z",
      limit: 10,
    });
    expect(triggerClaim).toMatchObject({
      batchId: "batch-1",
      suiteId: "suite-1",
      status: "pending",
      nextRound: 2,
    });
    await repository.markPolling({
      batchId: "batch-1",
      ruleId: "recovery-1",
      workerId: "worker-1",
      sourceBuildNumber: 41,
      rebuildNumber: 42,
      rebuildUrl: "https://jenkins.internal/job/reset/42/",
      availableAt: "2026-08-23T00:00:05.000Z",
      updatedAt: createdAt,
    });

    const [pollClaim] = await repository.claimDue({
      workerId: "worker-1",
      now: "2026-08-23T00:00:05.000Z",
      leaseExpiresAt: "2026-08-23T00:00:35.000Z",
      limit: 10,
    });
    expect(pollClaim).toMatchObject({
      status: "polling",
      sourceBuildNumber: 41,
      rebuildNumber: 42,
    });
    await repository.markWaiting({
      batchId: "batch-1",
      ruleId: "recovery-1",
      workerId: "worker-1",
      availableAt: "2026-08-23T00:05:05.000Z",
      updatedAt: "2026-08-23T00:00:05.000Z",
    });

    await expect(
      repository.claimDue({
        workerId: "worker-2",
        now: "2026-08-23T00:05:04.999Z",
        leaseExpiresAt: "2026-08-23T00:05:34.999Z",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    const [resumeClaim] = await repository.claimDue({
      workerId: "worker-2",
      now: "2026-08-23T00:05:05.000Z",
      leaseExpiresAt: "2026-08-23T00:05:35.000Z",
      limit: 10,
    });
    expect(resumeClaim?.status).toBe("waiting");
    await expect(
      repository.completeWaitingStep({
        batchId: "batch-1",
        ruleId: "recovery-1",
        workerId: "worker-2",
        updatedAt: "2026-08-23T00:05:05.000Z",
      }),
    ).resolves.toEqual({ outcome: "round_released" });

    expect(
      handle.client
        .prepare("SELECT current_round AS round FROM run_batches WHERE id = ?")
        .get("batch-1"),
    ).toEqual({ round: 2 });
    expect(
      handle.client
        .prepare("SELECT held_round AS held FROM execution_runs WHERE id = ?")
        .get("run-1"),
    ).toEqual({ held: 0 });
    handle.close();
  });

  it("keeps the next round held until every parallel recovery wait has elapsed", async () => {
    const handle = await database();
    seedRecovery(handle, "batch-parallel", "waiting");
    handle.client
      .prepare(
        `INSERT INTO run_batch_round_recoveries
         (batch_id, rule_id, after_round, next_round, jenkins_job_url, api_key_ciphertext,
          wait_minutes, status, available_at, created_at, updated_at)
         VALUES ('batch-parallel', 'recovery-2', 1, 2,
          'https://jenkins.internal/job/reset-second/', 'encrypted-second', 10, 'waiting',
          '2026-08-23T00:10:00.000Z', ?, ?)`,
      )
      .run(createdAt, createdAt);
    const repository = new SqliteRoundRecoveryRepository(handle);

    const [firstClaim] = await repository.claimDue({
      workerId: "worker-1",
      now: createdAt,
      leaseExpiresAt: "2026-08-23T00:00:30.000Z",
      limit: 10,
    });
    expect(firstClaim?.ruleId).toBe("recovery-1");
    await expect(
      repository.completeWaitingStep({
        batchId: "batch-parallel",
        ruleId: "recovery-1",
        workerId: "worker-1",
        updatedAt: createdAt,
      }),
    ).resolves.toEqual({ outcome: "step_completed", remainingSteps: 1 });
    expect(
      handle.client
        .prepare("SELECT current_round AS round FROM run_batches WHERE id = ?")
        .get("batch-parallel"),
    ).toEqual({ round: 1 });
    expect(
      handle.client
        .prepare("SELECT held_round AS held FROM execution_runs WHERE id = 'run-1'")
        .get(),
    ).toEqual({ held: 2 });

    await expect(
      repository.claimDue({
        workerId: "worker-2",
        now: "2026-08-23T00:09:59.999Z",
        leaseExpiresAt: "2026-08-23T00:10:29.999Z",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    const [lastClaim] = await repository.claimDue({
      workerId: "worker-2",
      now: "2026-08-23T00:10:00.000Z",
      leaseExpiresAt: "2026-08-23T00:10:30.000Z",
      limit: 10,
    });
    expect(lastClaim?.ruleId).toBe("recovery-2");
    await expect(
      repository.completeWaitingStep({
        batchId: "batch-parallel",
        ruleId: "recovery-2",
        workerId: "worker-2",
        updatedAt: "2026-08-23T00:10:00.000Z",
      }),
    ).resolves.toEqual({ outcome: "round_released" });
    expect(
      handle.client
        .prepare("SELECT current_round AS round FROM run_batches WHERE id = ?")
        .get("batch-parallel"),
    ).toEqual({ round: 2 });
    expect(
      handle.client
        .prepare("SELECT held_round AS held FROM execution_runs WHERE id = 'run-1'")
        .get(),
    ).toEqual({ held: 0 });
    handle.close();
  });

  it("turns Jenkins failure into an orchestration batch failure", async () => {
    const handle = await database();
    seedRecovery(handle, "batch-2", "pending");
    const repository = new SqliteRoundRecoveryRepository(handle);
    await repository.claimDue({
      workerId: "worker-1",
      now: createdAt,
      leaseExpiresAt: "2026-08-23T00:00:30.000Z",
      limit: 10,
    });

    await expect(
      repository.fail({
        batchId: "batch-2",
        ruleId: "recovery-1",
        workerId: "worker-1",
        errorMessage: "Jenkins build failed",
        eventId: "failure-event",
        updatedAt: "2026-08-23T00:00:01.000Z",
      }),
    ).resolves.toBe(true);

    expect(
      handle.client.prepare("SELECT status FROM run_batches WHERE id = ?").get("batch-2"),
    ).toEqual({ status: "failed" });
    expect(
      handle.client
        .prepare("SELECT status, terminal_reason_code AS reason FROM execution_runs WHERE id = ?")
        .get("run-1"),
    ).toEqual({ status: "failed", reason: "JENKINS_ROUND_RECOVERY_FAILED" });
    handle.close();
  });
});

async function database(): Promise<SqliteDatabaseHandle> {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-round-recovery-"));
  directories.push(directory);
  return createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
}

function seedRecovery(
  handle: SqliteDatabaseHandle,
  batchId: string,
  status: "pending" | "polling" | "waiting",
): void {
  handle.client
    .prepare(
      `INSERT INTO run_batches
       (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
        retry_mode, current_round, environment_json, secret_bindings_json, total_runs,
        project_id, scheduled_for, created_at, updated_at)
       VALUES (?, 1, 'suite-1', 'Smoke', 1, 'queued', 1, 'round', 1, '[]', '[]', 1,
        '00000000-0000-7000-8000-000000000001', ?, ?, ?)`,
    )
    .run(batchId, createdAt, createdAt, createdAt);
  handle.client
    .prepare(
      `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        parameters_json, status, attempt_count, held_round, queue_deadline_at,
        execution_timeout_ms, upload_timeout_ms, version, created_at, updated_at)
       VALUES ('run-1', ?, 'case-1', 1, 'Case 1', 'example.Case1', '{}', 'queued', 1, 2,
        '2026-08-24T00:00:00.000Z', 600000, 600000, 1, ?, ?)`,
    )
    .run(batchId, createdAt, createdAt);
  handle.client
    .prepare(
      `INSERT INTO run_batch_round_recoveries
       (batch_id, rule_id, after_round, next_round, jenkins_job_url, api_key_ciphertext,
        wait_minutes, status, available_at, created_at, updated_at)
       VALUES (?, 'recovery-1', 1, 2, 'https://jenkins.internal/job/reset/',
        'encrypted', 5, ?, ?, ?, ?)`,
    )
    .run(batchId, status, createdAt, createdAt, createdAt);
}
