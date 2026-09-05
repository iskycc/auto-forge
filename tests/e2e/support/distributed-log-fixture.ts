import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAttemptLogStore,
  createPostgresDatabase,
  NodeAttemptLogStore,
  createNodeLogTransport,
} from "@autoforge/db/postgres";

export async function distributedLogFixture(nodeIds: [string, string]) {
  const connectionString = process.env.AUTOFORGE_E2E_POSTGRES_URL;
  const masterKey = process.env.E2E_PLATFORM_MASTER_KEY;
  if (!connectionString || !masterKey)
    throw new Error("Distributed E2E requires isolated PostgreSQL and shared test credentials.");
  const handle = createPostgresDatabase({
    connectionString,
    migrationsFolder: resolve("packages/db/drizzle/postgresql"),
    poolMax: 2,
  });
  await handle.ready;
  const runnerId = randomUUID();
  const credential = randomBytes(32).toString("hex");
  const leaseToken = randomBytes(32).toString("hex");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const batchId = randomUUID();
  const attemptIds = [randomUUID(), randomUUID()] as const;
  await handle.pool.query(
    `INSERT INTO runners
       (id, credential_hash, name, disabled, draining, os, architecture, agent_version,
        protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots,
        last_seen_at, created_at, updated_at)
     VALUES ($1, $2, 'Runner One', FALSE, FALSE, 'linux', 'amd64', '0.4.0',
             1, '{}', '[]', 2, 0, '2026-08-17T00:00:00.000Z',
             '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    [runnerId, digest(credential)],
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

  const assignmentId = randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await handle.pool.query(
    `INSERT INTO assignments (id,attempt_id,execution_run_id,batch_id,runner_id,status,
       execution_spec_json,available_at,claim_deadline_at,created_at,updated_at)
     VALUES ($1,$2,$2,$3,$4,'running','{}',$5,$6,$5,$5)`,
    [assignmentId, attemptIds[0], batchId, runnerId, now, expiresAt],
  );
  await handle.pool.query(
    `INSERT INTO assignment_leases (id,assignment_id,runner_id,token_hash,token_encrypted,status,
       expires_at,renewed_at,created_at) VALUES ($1,$2,$3,$4,'fixture','active',$5,$6,$6)`,
    [randomUUID(), assignmentId, runnerId, digest(leaseToken), expiresAt, now],
  );
  await handle.pool.query("INSERT INTO run_batch_log_locations(batch_id,node_id) VALUES($1,$2)", [
    batchId,
    nodeIds[0],
  ]);
  const directory = await mkdtemp(join(tmpdir(), "autoforge-distributed-browser-"));
  const logStore = new NodeAttemptLogStore(
    handle,
    nodeIds[1],
    createAttemptLogStore(directory),
    createNodeLogTransport(masterKey, nodeIds[1], { now: () => new Date() }),
    directory,
    { now: () => new Date() },
  );
  return {
    batchId,
    attemptId: attemptIds[0],
    runnerId,
    credential,
    leaseToken,
    logStore,
    async owner() {
      const result = await handle.pool.query<{ node_id: string }>(
        "SELECT node_id FROM run_batch_log_locations WHERE batch_id=$1",
        [batchId],
      );
      return result.rows[0]?.node_id;
    },
    async dispose() {
      await logStore.removeBatchStore(batchId);
      logStore.close();
      await handle.pool.query("DELETE FROM run_batches WHERE id=$1", [batchId]);
      await handle.pool.query("DELETE FROM run_batch_log_locations WHERE batch_id=$1", [batchId]);
      await handle.pool.query("DELETE FROM runners WHERE id=$1", [runnerId]);
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
