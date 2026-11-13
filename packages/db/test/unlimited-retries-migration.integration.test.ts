import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import { runSqliteMigrations } from "../src/migrations";
import { runPostgresMigrations } from "../src/postgres-database";

it.skipIf(!process.env.AUTOFORGE_TEST_POSTGRES_URL)(
  "upgrades Full retry counts beyond INTEGER without losing history and rolls back failed upgrades",
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "full-unlimited-upgrade-"));
    const admin = new Client({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL! });
    const database = `unlimited_upgrade_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
    url.pathname = `/${database}`;
    let pool: Pool | undefined;
    let created = false;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${database}`);
      created = true;
      pool = new Pool({ connectionString: url.toString(), max: 1 });
      const folder = resolve(import.meta.dirname, "../drizzle/postgresql");
      const migration = "0101_unlimited_retries.sql";
      for (const file of (await readdir(folder)).filter(
        (name) => name.endsWith(".sql") && name < migration,
      ))
        await copyFile(resolve(folder, file), resolve(directory, file));
      await runPostgresMigrations(pool, directory);
      await pool.query(`INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,created_at,updated_at) VALUES('batch','suite','suite',1,'succeeded',10,'[]',1,'2026-11-13','2026-11-13');
      INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,created_at,updated_at) VALUES('run','batch','case',1,'case','example.Case','succeeded','2026-11-13','2026-11-13');`);
      const sql = await readFile(resolve(folder, migration), "utf8");
      await writeFile(
        resolve(directory, migration),
        sql + "\nSELECT * FROM injected_upgrade_failure;",
      );
      await expect(runPostgresMigrations(pool, directory)).rejects.toThrow(
        "injected_upgrade_failure",
      );
      await expect(
        pool.query("UPDATE run_batches SET retry_limit=25 WHERE id='batch'"),
      ).rejects.toThrow();
      expect((await pool.query("SELECT id FROM execution_runs")).rows).toEqual([{ id: "run" }]);
      await writeFile(resolve(directory, migration), sql);
      await runPostgresMigrations(pool, directory);
      await pool.query("UPDATE run_batches SET retry_limit=5000000000 WHERE id='batch'");
      expect(
        Number((await pool.query("SELECT retry_limit FROM run_batches")).rows[0].retry_limit),
      ).toBe(5000000000);
      expect((await pool.query("SELECT id FROM execution_runs")).rows).toEqual([{ id: "run" }]);
      await expect(
        pool.query("UPDATE run_batches SET retry_limit=-1 WHERE id='batch'"),
      ).rejects.toThrow();
    } finally {
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("upgrades a populated Lite database without deleting child history and restores constraints on migration failure", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "unlimited-retry-upgrade-"));
  const client = new Database(":memory:");
  const folder = resolve(import.meta.dirname, "../drizzle/sqlite");
  const migration = "0102_unlimited_retries.sql";
  try {
    client.pragma("foreign_keys=ON");
    for (const file of (await readdir(folder)).filter(
      (name) => name.endsWith(".sql") && name < migration,
    ))
      await copyFile(resolve(folder, file), resolve(directory, file));
    runSqliteMigrations(client, directory);
    client.exec(`INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,created_at,updated_at) VALUES('batch','suite','suite',1,'succeeded',10,'[]',1,'2026-11-13','2026-11-13');
      INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,created_at,updated_at) VALUES('run','batch','case',1,'case','example.Case','succeeded','2026-11-13','2026-11-13');
      INSERT INTO run_batch_status_events(id,batch_id,to_status,batch_version,reason,recorded_at) VALUES('event','batch','succeeded',1,'completed','2026-11-13');`);
    const sql = await readFile(resolve(folder, migration), "utf8");
    await writeFile(
      resolve(directory, migration),
      sql + "\nSELECT * FROM injected_migration_failure;",
    );
    expect(() => runSqliteMigrations(client, directory)).toThrow("injected_migration_failure");
    expect(client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(client.prepare("SELECT id FROM execution_runs").all()).toEqual([{ id: "run" }]);
    expect(() =>
      client.prepare("UPDATE run_batches SET retry_limit=100 WHERE id='batch'").run(),
    ).toThrow();
    await writeFile(resolve(directory, migration), sql);
    runSqliteMigrations(client, directory);
    expect(client.prepare("SELECT id FROM execution_runs").all()).toEqual([{ id: "run" }]);
    expect(client.prepare("SELECT id FROM run_batch_status_events").all()).toEqual([
      { id: "event" },
    ]);
    client.prepare("UPDATE run_batches SET retry_limit=? WHERE id='batch'").run(5000000000);
    expect(client.prepare("SELECT retry_limit FROM run_batches").get()).toEqual({
      retry_limit: 5000000000,
    });
    expect(() =>
      client.prepare("UPDATE run_batches SET retry_limit=-1 WHERE id='batch'").run(),
    ).toThrow();
    expect(client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(client.pragma("foreign_key_check")).toEqual([]);
    runSqliteMigrations(client, directory);
    expect(client.prepare("SELECT id FROM execution_runs").all()).toEqual([{ id: "run" }]);
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
