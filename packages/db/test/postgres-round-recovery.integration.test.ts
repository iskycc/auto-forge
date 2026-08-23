import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";

import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";
import { PostgresRoundRecoveryRepository } from "../src/postgres-round-recovery";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const createdAt = "2026-08-23T00:00:00.000Z";

describe.skipIf(!connectionString)("PostgreSQL round recovery", () => {
  it("removes an encrypted task credential when its recovery rule is deleted", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    await handle.ready;
    const suiteId = `recovery-suite-${randomUUID()}`;
    const suites = new PostgresCaseSuiteRepository(handle);
    try {
      await suites.create({ id: suiteId, name: "Recovery", createdAt });
      await suites.updateSuite({
        suiteId,
        expectedRevision: 1,
        versionId: randomUUID(),
        changeReason: "suite.update:policy",
        updatedAt: createdAt,
        policy: {
          ...defaultCaseSuiteExecutionPolicy,
          retryMode: "round",
          retryLimit: 1,
          roundRecoveryRules: [
            {
              id: "recovery-1",
              afterRound: 1,
              jenkinsJobUrl: "https://jenkins.internal/job/reset/",
              waitMinutes: 5,
              apiKeyConfigured: true,
            },
          ],
        },
        roundRecoveryCredentialUpserts: { "recovery-1": "encrypted-credential" },
      });
      await expect(suites.getRoundRecoveryCredentials(suiteId, ["recovery-1"])).resolves.toEqual({
        "recovery-1": "encrypted-credential",
      });

      await suites.updateSuite({
        suiteId,
        expectedRevision: 2,
        versionId: randomUUID(),
        changeReason: "suite.update:policy",
        updatedAt: createdAt,
        policy: { ...defaultCaseSuiteExecutionPolicy },
      });
      await expect(suites.getRoundRecoveryCredentials(suiteId, ["recovery-1"])).resolves.toEqual(
        {},
      );
    } finally {
      await handle.pool.query("DELETE FROM case_suites WHERE id = $1", [suiteId]);
      await handle.close();
    }
  });

  it("leases and resumes a held retry round with the same semantics as Lite", async () => {
    const handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    await handle.ready;
    const suffix = randomUUID();
    const batchId = `recovery-batch-${suffix}`;
    const runId = `recovery-run-${suffix}`;
    const ruleId = `recovery-rule-${suffix}`;
    try {
      await handle.pool.query(
        `INSERT INTO run_batches
         (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
          retry_mode, current_round, environment_json, secret_bindings_json, total_runs,
          project_id, scheduled_for, created_at, updated_at)
         VALUES ($1, nextval('run_batch_sequence_numbers'), 'suite-full', 'Smoke', 1,
          'queued', 1, 'round', 1, '[]', '[]', 1,
          '00000000-0000-7000-8000-000000000001', $2, $2, $2)`,
        [batchId, createdAt],
      );
      await handle.pool.query(
        `INSERT INTO execution_runs
         (id, batch_id, case_definition_id, case_version, display_name, class_name,
          parameters_json, status, attempt_count, held_round, queue_deadline_at,
          execution_timeout_ms, upload_timeout_ms, version, created_at, updated_at)
         VALUES ($1, $2, $3, 1, 'Case 1', 'example.Case1', '{}', 'queued', 1, 2,
          '2026-08-24T00:00:00.000Z', 600000, 600000, 1, $4, $4)`,
        [runId, batchId, `case-${suffix}`, createdAt],
      );
      await handle.pool.query(
        `INSERT INTO run_batch_round_recoveries
         (batch_id, rule_id, after_round, next_round, jenkins_job_url,
          api_key_ciphertext, wait_minutes, status, available_at, created_at, updated_at)
         VALUES ($1, $2, 1, 2, 'https://jenkins.internal/job/reset/',
          'encrypted', 0, 'waiting', $3, $3, $3)`,
        [batchId, ruleId, createdAt],
      );
      const repository = new PostgresRoundRecoveryRepository(handle);

      const [claim] = await repository.claimDue({
        workerId: "full-worker",
        now: createdAt,
        leaseExpiresAt: "2026-08-23T00:00:30.000Z",
        limit: 10,
      });
      expect(claim).toMatchObject({ batchId, ruleId, status: "waiting", nextRound: 2 });
      await expect(
        repository.resume({
          batchId,
          ruleId,
          workerId: "full-worker",
          updatedAt: createdAt,
        }),
      ).resolves.toBe(true);

      await expect(
        handle.pool.query<{ current_round: number }>(
          "SELECT current_round FROM run_batches WHERE id = $1",
          [batchId],
        ),
      ).resolves.toMatchObject({ rows: [{ current_round: 2 }] });
      await expect(
        handle.pool.query<{ held_round: number }>(
          "SELECT held_round FROM execution_runs WHERE id = $1",
          [runId],
        ),
      ).resolves.toMatchObject({ rows: [{ held_round: 0 }] });
    } finally {
      await handle.pool.query("DELETE FROM run_batches WHERE id = $1", [batchId]);
      await handle.close();
    }
  });
});
