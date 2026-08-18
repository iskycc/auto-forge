import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe } from "vitest";

import { PostgresAttemptLogShareRepository } from "../src/postgres-attempt-log-share";
import { createPostgresDatabase } from "../src/postgres-database";
import { attemptLogShareContract, type AttemptLogShareHarness } from "./attempt-log-share.contract";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

// 与 SQLite 契约同一批断言：无 PostgreSQL 连接串时整体跳过。
describe.skipIf(!connectionString)("PostgreSQL attempt log share", () => {
  attemptLogShareContract("PostgreSQL", createHarness);
});

async function createHarness(): Promise<AttemptLogShareHarness> {
  const handle = createPostgresDatabase({
    connectionString: connectionString!,
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
  });
  await handle.ready;
  // 最小外键链：runner -> run_batches -> execution_runs -> run_attempts（两条 run/attempt）。
  // PG 测试库共享，fixture ID 全部随机，避免与其他用例或并行执行冲突。
  const runnerId = randomUUID();
  const batchId = randomUUID();
  const attemptIds = [randomUUID(), randomUUID()] as const;
  await handle.pool.query(
    `INSERT INTO runners
       (id, credential_hash, name, disabled, draining, os, architecture, agent_version,
        protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots,
        last_seen_at, created_at, updated_at)
     VALUES ($1, 'hash', 'Runner One', FALSE, FALSE, 'linux', 'amd64', '0.4.0',
             1, '{}', '[]', 2, 0, '2026-08-17T00:00:00.000Z',
             '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    [runnerId],
  );
  await handle.pool.query(
    `INSERT INTO run_batches
       (id, suite_id, suite_name, suite_version, status, retry_limit, total_runs,
        environment_json, created_at, updated_at)
     VALUES ($1, 'suite-1', '回归套件', 1, 'running', 3, 2, '[]',
             '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    [batchId],
  );
  await handle.pool.query(
    `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        status, attempt_count, created_at, updated_at)
     VALUES
       ($1, $3, $1, 1, 'run-1#method', 'com.example.RunOne',
        'running', 1, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
       ($2, $3, $2, 1, 'run-2#method', 'com.example.RunTwo',
        'running', 1, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    [attemptIds[0], attemptIds[1], batchId],
  );
  await handle.pool.query(
    `INSERT INTO run_attempts
       (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at)
     VALUES
       ($1, $1, $3, 1, 'running', 1.0, '2026-08-17T00:00:00.000Z'),
       ($2, $2, $3, 1, 'running', 1.0, '2026-08-17T00:00:00.000Z')`,
    [attemptIds[0], attemptIds[1], runnerId],
  );
  return {
    repository: new PostgresAttemptLogShareRepository(handle),
    fixture: { batchId, attemptIds },
    async dispose() {
      await handle.close();
    },
  };
}
