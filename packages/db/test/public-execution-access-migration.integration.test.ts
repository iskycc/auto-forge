import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

type MigrationHarness = {
  execute(sql: string): Promise<void>;
  rows(sql: string): Promise<Array<Record<string, unknown>>>;
  tableExists(name: string): Promise<boolean>;
  dispose(): Promise<void>;
};

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !connectionString)(
    `${dialect} public execution access upgrade`,
    { timeout: 30_000 },
    () => {
      it("preserves legacy tokens and keeps existing records unpublished on upgrade", async () => {
        const harness = await createHarness(dialect);
        try {
          const migration = await preparePreviousVersion(harness, dialect);
          await applyMigration(harness, migration);
          expect(await harness.rows("SELECT token_hash FROM attempt_log_shares")).toEqual([
            { token_hash: "legacy-hash" },
          ]);
          expect(await harness.rows("SELECT * FROM public_batch_access")).toEqual([]);
          expect(await harness.rows("SELECT * FROM public_attempt_access")).toEqual([]);
          expect(await harness.rows("SELECT id FROM run_batches")).toEqual([
            { id: "legacy-batch" },
          ]);
        } finally {
          await harness.dispose();
        }
      });

      it("rolls back an interrupted migration and can reapply it without losing history", async () => {
        const harness = await createHarness(dialect);
        try {
          const migration = await preparePreviousVersion(harness, dialect);
          await expect(
            applyMigration(
              harness,
              `${migration}\nINSERT INTO missing_migration_table VALUES (1);`,
            ),
          ).rejects.toThrow();
          expect(await harness.tableExists("public_batch_access")).toBe(false);
          expect(await harness.tableExists("public_attempt_access")).toBe(false);
          expect(await harness.rows("SELECT token_hash FROM attempt_log_shares")).toEqual([
            { token_hash: "legacy-hash" },
          ]);
          await applyMigration(harness, migration);
          expect(await harness.tableExists("public_batch_access")).toBe(true);
          expect(await harness.tableExists("public_attempt_access")).toBe(true);
        } finally {
          await harness.dispose();
        }
      });
    },
  );
}

async function applyMigration(harness: MigrationHarness, sql: string): Promise<void> {
  await harness.execute("BEGIN");
  try {
    await harness.execute(sql);
    await harness.execute("COMMIT");
  } catch (cause) {
    await harness.execute("ROLLBACK");
    throw cause;
  }
}

async function preparePreviousVersion(
  harness: MigrationHarness,
  dialect: "sqlite" | "postgresql",
): Promise<string> {
  const folder = resolve(import.meta.dirname, "../drizzle", dialect);
  const files = (await readdir(folder)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const migration = files.find((name) => name.endsWith("_public_execution_access.sql"))!;
  for (const name of files.slice(0, files.indexOf(migration)))
    await harness.execute(await readFile(resolve(folder, name), "utf8"));
  await harness.execute(`
    INSERT INTO runners (id, credential_hash, name, disabled, draining, os, architecture, agent_version, protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots, last_seen_at, created_at, updated_at)
    VALUES ('legacy-runner', 'fixture-hash', 'Legacy Runner', FALSE, FALSE, 'linux', 'amd64', '0.4.0', 1, '{}', '[]', 1, 0, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z');
    INSERT INTO run_batches (id, suite_id, suite_name, suite_version, status, retry_limit, total_runs, environment_json, created_at, updated_at)
    VALUES ('legacy-batch', 'legacy-suite', 'Legacy Suite', 1, 'succeeded', 0, 1, '[]', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z');
    INSERT INTO execution_runs (id, batch_id, case_definition_id, case_version, display_name, class_name, status, attempt_count, created_at, updated_at)
    VALUES ('legacy-run', 'legacy-batch', 'legacy-case', 1, 'Legacy Case', 'com.example.Legacy', 'succeeded', 1, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z');
    INSERT INTO run_attempts (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at)
    VALUES ('legacy-attempt', 'legacy-run', 'legacy-runner', 1, 'succeeded', 1, '2026-10-10T00:00:00.000Z');
    INSERT INTO attempt_log_shares (id, token_hash, attempt_id, batch_id, created_by, created_at, expires_at)
    VALUES ('legacy-link', 'legacy-hash', 'legacy-attempt', 'legacy-batch', 'legacy-reader', '2026-10-10T00:00:00.000Z', '9999-12-31T23:59:59.999Z');
  `);
  return readFile(resolve(folder, migration), "utf8");
}

async function createHarness(dialect: "sqlite" | "postgresql"): Promise<MigrationHarness> {
  if (dialect === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-public-access-upgrade-"));
    const client = new Database(resolve(directory, "upgrade.sqlite"));
    client.pragma("foreign_keys = ON");
    return {
      async execute(sql) {
        client.exec(sql);
      },
      async rows(sql) {
        return client.prepare(sql).all() as Array<Record<string, unknown>>;
      },
      async tableExists(name) {
        return !!client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name);
      },
      async dispose() {
        client.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const databaseName = `autoforge_public_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: connectionString! });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(connectionString!);
  url.pathname = `/${databaseName}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return {
    async execute(sql) {
      await client.query(sql);
    },
    async rows(sql) {
      return (await client.query(sql)).rows as Array<Record<string, unknown>>;
    },
    async tableExists(name) {
      return (
        (
          await client.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
            [name],
          )
        ).rowCount === 1
      );
    },
    async dispose() {
      await client.end();
      await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      await admin.end();
    },
  };
}
