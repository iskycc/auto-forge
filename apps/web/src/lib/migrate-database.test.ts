import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrateSqliteDatabase } from "./migrate-database";

describe("one-shot database migration", () => {
  it("applies ordered migrations once and rejects changes to an applied file", () => {
    const root = mkdtempSync(join(tmpdir(), "autoforge-migrate-"));
    const databasePath = join(root, "data", "autoforge.db");
    writeFileSync(join(root, "0002_second.sql"), "ALTER TABLE sample ADD COLUMN note TEXT;");
    writeFileSync(join(root, "0001_first.sql"), "CREATE TABLE sample(id TEXT PRIMARY KEY);");

    migrateSqliteDatabase(databasePath, root);
    migrateSqliteDatabase(databasePath, root);

    const database = new Database(databasePath, { readonly: true });
    expect(database.prepare("SELECT name FROM _autoforge_migrations ORDER BY name").all()).toEqual([
      { name: "0001_first.sql" },
      { name: "0002_second.sql" },
    ]);
    expect(database.prepare("PRAGMA table_info(sample)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "note" })]),
    );
    database.close();

    const changed = `${readFileSync(join(root, "0001_first.sql"), "utf8")}\n-- changed`;
    writeFileSync(join(root, "0001_first.sql"), changed);
    expect(() => migrateSqliteDatabase(databasePath, root)).toThrow(
      "Applied migration 0001_first.sql was modified.",
    );
  });

  it("rolls back a failed migration and resumes after the file is corrected", () => {
    const root = mkdtempSync(join(tmpdir(), "autoforge-migrate-recovery-"));
    const databasePath = join(root, "data", "autoforge.db");
    writeFileSync(join(root, "0001_first.sql"), "CREATE TABLE sample(id TEXT PRIMARY KEY);");
    writeFileSync(
      join(root, "0002_broken.sql"),
      "INSERT INTO sample(id) VALUES('must-rollback'); INVALID SQL;",
    );

    expect(() => migrateSqliteDatabase(databasePath, root)).toThrow();
    const failed = new Database(databasePath);
    expect(failed.prepare("SELECT * FROM sample").all()).toEqual([]);
    expect(failed.prepare("SELECT name FROM _autoforge_migrations ORDER BY name").all()).toEqual([
      { name: "0001_first.sql" },
    ]);
    failed.close();

    writeFileSync(join(root, "0002_broken.sql"), "INSERT INTO sample(id) VALUES('recovered');");
    migrateSqliteDatabase(databasePath, root);
    const recovered = new Database(databasePath, { readonly: true });
    expect(recovered.prepare("SELECT * FROM sample").all()).toEqual([{ id: "recovered" }]);
    recovered.close();
  });
});
