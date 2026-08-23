import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresWebhookRepository } from "../src/postgres-webhook";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const PROJECT_ID = "00000000-0000-7000-8000-000000000001";

describe.skipIf(!connectionString)("PostgreSQL webhook delivery", () => {
  it("claims one idempotent delivery for a terminal task batch", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    await handle.ready;
    const suffix = randomUUID();
    const suiteId = `webhook-suite-${suffix}`;
    const batchId = `webhook-batch-${suffix}`;
    const webhookId = `webhook-${suffix}`;
    const completedAt = "2026-08-23T08:00:00.000Z";
    const repository = new PostgresWebhookRepository(handle);
    try {
      await handle.pool.query(
        `INSERT INTO case_suites
          (id, project_id, name, description, version, status, enabled, revision,
           policy_json, created_at, updated_at)
         VALUES ($1, $2, 'Full 回归任务', '', 1, 'active', TRUE, 1, '{}', $3, $3)`,
        [suiteId, PROJECT_ID, "2026-08-23T07:00:00.000Z"],
      );
      await handle.pool.query(
        `INSERT INTO run_batches
          (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
           environment_json, total_runs, project_id, created_at, updated_at)
         VALUES ($1, 43, $2, 'Full 回归任务', 1, 'cancelled', 0, '[]', 1, $3, $4, $5)`,
        [batchId, suiteId, PROJECT_ID, "2026-08-23T07:10:00.000Z", completedAt],
      );
      await handle.pool.query(
        `INSERT INTO execution_runs
          (id, batch_id, case_definition_id, case_version, display_name, class_name,
           status, attempt_count, created_at, updated_at)
         VALUES ($1, $2, $3, 1, '取消用例', 'example.CancelledTest', 'cancelled', 1, $4, $5)`,
        [`run-${suffix}`, batchId, `case-${suffix}`, "2026-08-23T07:10:00.000Z", completedAt],
      );
      await handle.pool.query(
        `INSERT INTO run_batch_status_events
          (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
         VALUES ($1, $2, 'running', 'cancelled', 2, 'cancelled', $3)`,
        [`event-${suffix}`, batchId, completedAt],
      );
      await repository.createConfiguration({
        id: webhookId,
        projectId: PROJECT_ID,
        name: `Full 通知 ${suffix}`,
        normalizedName: `full 通知 ${suffix}`,
        description: "",
        targetUrl: "https://hooks.example.test/full",
        method: "GET",
        enabled: true,
        recordedAt: "2026-08-23T07:00:00.000Z",
      });
      await repository.replaceSuiteBindings({
        suiteId,
        webhookIds: [webhookId],
        recordedAt: "2026-08-23T07:05:00.000Z",
        projectIds: [PROJECT_ID],
      });

      await expect(repository.materializeDeliveries({ now: completedAt, limit: 10 })).resolves.toBe(
        1,
      );
      await expect(repository.materializeDeliveries({ now: completedAt, limit: 10 })).resolves.toBe(
        0,
      );
      await expect(
        repository.claimDueDeliveries({
          owner: `worker-${suffix}`,
          now: completedAt,
          leaseExpiresAt: "2026-08-23T08:00:30.000Z",
          limit: 10,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          webhookId,
          attemptNumber: 1,
          batch: expect.objectContaining({ id: batchId, status: "cancelled", cancelledRuns: 1 }),
        }),
      ]);
    } finally {
      await handle.pool.query("DELETE FROM webhook_deliveries WHERE webhook_id = $1", [webhookId]);
      await handle.pool.query("DELETE FROM case_suite_webhook_bindings WHERE suite_id = $1", [
        suiteId,
      ]);
      await handle.pool.query("DELETE FROM webhook_configurations WHERE id = $1", [webhookId]);
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [batchId]);
      await handle.pool.query("DELETE FROM case_suites WHERE id = $1", [suiteId]);
      await handle.close();
    }
  });
});
