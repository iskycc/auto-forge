import { createHash, createHmac, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { createPostgresDatabase } from "@autoforge/db/postgres";

/** Emulates an existing pre-upgrade record; production endpoints never issue these URLs. */
export async function legacyAttemptLogPath(attemptId: string): Promise<string> {
  const token = `historical-${randomUUID()}`;
  const values = [
    randomUUID(),
    createHash("sha256").update(token).digest("hex"),
    "legacy-e2e-reader",
    "2026-08-01T00:00:00.000Z",
    "9999-12-31T23:59:59.999Z",
    attemptId,
  ];
  const insert = `INSERT INTO attempt_log_shares (id, token_hash, batch_id, attempt_id, created_by, created_at, expires_at)
    SELECT %1, %2, r.batch_id, a.id, %3, %4, %5 FROM run_attempts a JOIN execution_runs r ON r.id = a.execution_run_id WHERE a.id = %6`;
  const postgresUrl = process.env.AUTOFORGE_E2E_POSTGRES_URL;
  if (postgresUrl) {
    const handle = createPostgresDatabase({
      connectionString: postgresUrl,
      migrationsFolder: resolve(import.meta.dirname, "../../../packages/db/drizzle/postgresql"),
      poolMax: 1,
    });
    try {
      await handle.ready;
      const result = await handle.pool.query(
        insert.replace(/%(\d)/g, (_, number: string) => `$${number}`),
        values,
      );
      if (result.rowCount !== 1)
        throw new Error("Legacy public-log fixture requires an existing attempt.");
    } finally {
      await handle.close();
    }
  } else {
    const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
    if (!directory)
      throw new Error("Legacy public-link fixtures require the running E2E database.");
    const client = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
    try {
      client.exec("PRAGMA busy_timeout = 5000");
      const result = client.prepare(insert.replace(/%\d/g, "?")).run(...values);
      if (result.changes !== 1)
        throw new Error("Legacy public-log fixture requires an existing attempt.");
    } finally {
      client.close();
    }
  }
  return `/share/attempt-log/${token}`;
}

/** Recreates the previous stateless format solely to verify upgrade compatibility. */
export function legacyExecutionPath(batchId: string): string {
  const masterKey = process.env.E2E_RUNNER_BOOTSTRAP_MASTER_KEY;
  if (!masterKey) throw new Error("Legacy public-detail fixtures require the E2E signing key.");
  const payload = Buffer.from(
    JSON.stringify({ version: 1, resourceType: "run_batch", resourceId: batchId }),
  ).toString("base64url");
  const signature = createHmac("sha256", masterKey)
    .update(`permanent-share:${payload}`)
    .digest("base64url");
  return `/share/run/${payload}.${signature}`;
}
