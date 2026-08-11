import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { Pool, type PoolClient } from "pg";

export function migrateSqliteDatabase(databasePath: string, migrationsFolder: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    database.exec(`CREATE TABLE IF NOT EXISTS _autoforge_migrations (
      name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const find = database.prepare("SELECT sha256 FROM _autoforge_migrations WHERE name=?");
    const insert = database.prepare(
      "INSERT INTO _autoforge_migrations(name,sha256,applied_at) VALUES(?,?,?)",
    );
    const apply = database.transaction((fileName: string, sql: string, digest: string) => {
      const current = find.get(fileName) as { sha256: string } | undefined;
      if (current?.sha256 !== undefined && current.sha256 !== digest) {
        throw new Error(`Applied migration ${fileName} was modified.`);
      }
      if (current) return;
      database.exec(sql);
      insert.run(fileName, digest, new Date().toISOString());
    });
    for (const fileName of migrationFiles(migrationsFolder)) {
      const sql = readFileSync(join(migrationsFolder, fileName), "utf8");
      apply.immediate(fileName, sql, contentDigest(sql));
    }
  } finally {
    database.close();
  }
}

export async function migratePostgresDatabase(
  connectionString: string,
  migrationsFolder: string,
): Promise<void> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  const client = await pool.connect();
  try {
    await inPostgresTransaction(client, async () => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('autoforge_migrations'))");
      await client.query(`CREATE TABLE IF NOT EXISTS _autoforge_migrations (
        name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL
      )`);
      const applied = await client.query<{ name: string; sha256: string }>(
        "SELECT name,sha256 FROM _autoforge_migrations",
      );
      const known = new Map(applied.rows.map((row) => [row.name, row.sha256]));
      for (const fileName of migrationFiles(migrationsFolder)) {
        const sql = readFileSync(join(migrationsFolder, fileName), "utf8");
        const sha256 = contentDigest(sql);
        const current = known.get(fileName);
        if (current && current !== sha256) {
          throw new Error(`Applied migration ${fileName} was modified.`);
        }
        if (current) continue;
        await client.query(sql);
        await client.query(
          "INSERT INTO _autoforge_migrations(name,sha256,applied_at) VALUES($1,$2,$3)",
          [fileName, sha256, new Date().toISOString()],
        );
      }
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function inPostgresTransaction(
  client: PoolClient,
  operation: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await operation();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function migrationFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort();
}

function contentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
