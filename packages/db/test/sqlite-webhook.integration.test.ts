import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase, type SqliteDatabaseHandle } from "../src/database";
import { SqliteWebhookRepository } from "../src/sqlite-webhook";

const PROJECT_ID = "00000000-0000-7000-8000-000000000001";
const CREATED_AT = "2026-08-23T07:00:00.000Z";
const COMPLETED_AT = "2026-08-23T08:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SqliteWebhookRepository", () => {
  it("materializes a terminal batch once and preserves assertion failures in its payload", async () => {
    const handle = await database();
    seedCompletedBatch(handle);
    const repository = new SqliteWebhookRepository(handle);
    await repository.createConfiguration({
      id: "webhook-1",
      projectId: PROJECT_ID,
      name: "质量群",
      normalizedName: "质量群",
      description: "",
      targetUrl: "https://hooks.example.test/quality",
      method: "POST",
      bodyTemplate: '{"status":"{{batch.status}}"}',
      enabled: true,
      recordedAt: CREATED_AT,
    });
    await repository.replaceSuiteBindings({
      suiteId: "suite-1",
      webhookIds: ["webhook-1"],
      recordedAt: "2026-08-23T07:05:00.000Z",
      projectIds: [PROJECT_ID],
    });

    await expect(repository.materializeDeliveries({ now: COMPLETED_AT, limit: 100 })).resolves.toBe(
      1,
    );
    await expect(repository.materializeDeliveries({ now: COMPLETED_AT, limit: 100 })).resolves.toBe(
      0,
    );
    const claims = await repository.claimDueDeliveries({
      owner: "worker-1",
      now: COMPLETED_AT,
      leaseExpiresAt: "2026-08-23T08:00:30.000Z",
      limit: 20,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      webhookId: "webhook-1",
      leaseOwner: "worker-1",
      attemptNumber: 1,
      batch: {
        id: "batch-1",
        status: "succeeded",
        totalRuns: 2,
        succeededRuns: 1,
        failedRuns: 1,
        cancelledRuns: 0,
      },
    });

    await repository.completeDelivery({
      deliveryId: claims[0]!.deliveryId,
      owner: "worker-1",
      responseStatus: 202,
      completedAt: "2026-08-23T08:00:01.000Z",
    });
    await expect(repository.listDeliveries(PROJECT_ID, 10)).resolves.toEqual([
      expect.objectContaining({ status: "succeeded", attempts: 1, responseStatus: 202 }),
    ]);
    handle.close();
  });

  it("does not backfill old completions after a new binding is added", async () => {
    const handle = await database();
    seedCompletedBatch(handle);
    const repository = new SqliteWebhookRepository(handle);
    await repository.createConfiguration({
      id: "webhook-late",
      projectId: PROJECT_ID,
      name: "后来创建",
      normalizedName: "后来创建",
      description: "",
      targetUrl: "https://hooks.example.test/late",
      method: "GET",
      enabled: true,
      recordedAt: "2026-08-23T09:00:00.000Z",
    });
    await repository.replaceSuiteBindings({
      suiteId: "suite-1",
      webhookIds: ["webhook-late"],
      recordedAt: "2026-08-23T09:00:00.000Z",
      projectIds: [PROJECT_ID],
    });
    await expect(
      repository.materializeDeliveries({ now: "2026-08-23T10:00:00.000Z", limit: 100 }),
    ).resolves.toBe(0);
    handle.close();
  });
});

async function database(): Promise<SqliteDatabaseHandle> {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-webhook-"));
  directories.push(directory);
  return createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
}

function seedCompletedBatch(handle: SqliteDatabaseHandle): void {
  handle.client
    .prepare(
      `INSERT INTO case_suites
        (id, project_id, name, description, version, status, enabled, revision,
         policy_json, created_at, updated_at)
       VALUES (?, ?, ?, '', 1, 'active', 1, 1, '{}', ?, ?)`,
    )
    .run("suite-1", PROJECT_ID, "回归任务", CREATED_AT, CREATED_AT);
  handle.client
    .prepare(
      `INSERT INTO run_batches
        (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
         environment_json, total_runs, project_id, created_at, updated_at)
       VALUES (?, 42, ?, ?, 1, 'succeeded', 0, '[]', 2, ?, ?, ?)`,
    )
    .run("batch-1", "suite-1", "回归任务", PROJECT_ID, CREATED_AT, COMPLETED_AT);
  const insertRun = handle.client.prepare(
    `INSERT INTO execution_runs
      (id, batch_id, case_definition_id, case_version, display_name, class_name,
       status, attempt_count, terminal_reason_code, created_at, updated_at)
     VALUES (?, 'batch-1', ?, 1, ?, ?, ?, 1, ?, ?, ?)`,
  );
  insertRun.run(
    "run-1",
    "case-1",
    "通过用例",
    "example.PassTest",
    "succeeded",
    null,
    CREATED_AT,
    COMPLETED_AT,
  );
  insertRun.run(
    "run-2",
    "case-2",
    "断言失败用例",
    "example.FailTest",
    "failed",
    "TESTNG_ASSERTIONS_FAILED",
    CREATED_AT,
    COMPLETED_AT,
  );
  handle.client
    .prepare(
      `INSERT INTO run_batch_status_events
        (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
       VALUES ('event-1', 'batch-1', 'running', 'succeeded', 2, 'all_runs_completed', ?)`,
    )
    .run(COMPLETED_AT);
}
