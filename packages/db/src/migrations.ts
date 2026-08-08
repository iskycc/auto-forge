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
  const appliedRows = client
    .prepare("SELECT name, sha256 FROM _autoforge_migrations")
    .all() as Array<{ name: string; sha256: string }>;
  const applied = new Map(appliedRows.map((row) => [row.name, row.sha256]));
  const insertMigration = client.prepare(
    "INSERT INTO _autoforge_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
  );

  for (const fileName of files) {
    const sql = readFileSync(join(migrationsFolder, fileName), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const existingChecksum = applied.get(fileName);
    if (existingChecksum && existingChecksum !== sha256) {
      throw new Error(`Applied migration ${fileName} was modified.`);
    }
    if (existingChecksum) {
      continue;
    }

    client.transaction(() => {
      client.exec(sql);
      insertMigration.run(fileName, sha256, new Date().toISOString());
    })();
  }
}
