import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

export function runSqliteMigrations(client: Database.Database, migrationsFolder: string): void {
  client.exec(`
    CREATE TABLE IF NOT EXISTS _autoforge_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const files = readdirSync(migrationsFolder)
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort();
  const findMigration = client.prepare("SELECT sha256 FROM _autoforge_migrations WHERE name = ?");
  const insertMigration = client.prepare(
    "INSERT INTO _autoforge_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
  );
  const applyMigration = client.transaction((migration: MigrationFile) => {
    const existing = findMigration.get(migration.name) as { sha256: string } | undefined;
    if (existing && existing.sha256 !== migration.sha256) {
      throw new Error(`Applied migration ${migration.name} was modified.`);
    }
    if (existing) return;

    client.exec(migration.sql);
    insertMigration.run(migration.name, migration.sha256, new Date().toISOString());
  });

  for (const fileName of files) {
    const sql = readFileSync(join(migrationsFolder, fileName), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    // BEGIN IMMEDIATE serializes the read-before-DDL decision across processes.
    // A deferred transaction lets multiple startup workers cache the same stale
    // "not applied" result and then repeat an ALTER TABLE after waiting for the writer.
    applyMigration.immediate({ name: fileName, sql, sha256 });
  }
}

type MigrationFile = {
  name: string;
  sql: string;
  sha256: string;
};
