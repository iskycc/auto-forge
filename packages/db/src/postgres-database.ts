import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { postgresSchema } from "./postgres-schema";

export type PostgresDatabaseHandle = {
  pool: Pool;
  db: NodePgDatabase<typeof postgresSchema>;
  ready: Promise<void>;
  close(): Promise<void>;
};

export function createPostgresDatabase(options: {
  connectionString: string;
  migrationsFolder: string;
}): PostgresDatabaseHandle {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  return {
    pool,
    db: drizzle(pool, { schema: postgresSchema }),
    ready: runPostgresMigrations(pool, options.migrationsFolder),
    close: () => pool.end(),
  };
}

async function runPostgresMigrations(pool: Pool, migrationsFolder: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('autoforge_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS _autoforge_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        sha256 TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const appliedResult = await client.query<{ name: string; sha256: string }>(
      "SELECT name, sha256 FROM _autoforge_migrations",
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.sha256]));
    const files = readdirSync(migrationsFolder)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    for (const fileName of files) {
      const migration = readFileSync(join(migrationsFolder, fileName), "utf8");
      const sha256 = createHash("sha256").update(migration).digest("hex");
      const existing = applied.get(fileName);
      if (existing && existing !== sha256)
        throw new Error(`Applied migration ${fileName} was modified.`);
      if (existing) continue;
      await client.query(migration);
      await client.query(
        "INSERT INTO _autoforge_migrations (name, sha256, applied_at) VALUES ($1, $2, $3)",
        [fileName, sha256, new Date().toISOString()],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
