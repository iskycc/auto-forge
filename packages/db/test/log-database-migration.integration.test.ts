import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !connectionString)(
    `${dialect} log database upgrade`,
    () => {
      it("preserves historical batches, rolls back interrupted DDL and upgrades without selecting a write database", async () => {
        const sqlite = dialect === "sqlite" ? new Database(":memory:") : undefined;
        const postgres = dialect === "postgresql" ? new Client({ connectionString }) : undefined;
        const namespace = `logs_migration_${randomUUID().replaceAll("-", "")}`;
        if (postgres) {
          await postgres.connect();
          await postgres.query(`CREATE SCHEMA ${namespace}`);
          await postgres.query(`SET search_path TO ${namespace}`);
        }
        const execute = async (sql: string) => {
          if (sqlite) sqlite.exec(sql);
          else await postgres!.query(sql);
        };
        const rows = async (sql: string) =>
          sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        try {
          const folder = resolve(import.meta.dirname, "../drizzle", dialect);
          const files = (await readdir(folder)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
          const latest = files.at(-1)!;
          expect(latest).toMatch(/_log_databases\.sql$/);
          for (const file of files.slice(0, -1))
            await execute(await readFile(resolve(folder, file), "utf8"));
          await execute(
            "INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES('history','suite','History',1,'failed',0,1,'[]','2026-10-27','2026-10-27')",
          );
          const migration = await readFile(resolve(folder, latest), "utf8");
          await execute("BEGIN");
          await expect(
            execute(`${migration}\nINSERT INTO missing_migration_table VALUES(1);`),
          ).rejects.toThrow();
          await execute("ROLLBACK");
          await expect(rows("SELECT * FROM log_databases")).rejects.toThrow();
          await execute("BEGIN");
          await execute(migration);
          await execute("COMMIT");
          expect(await rows("SELECT id FROM run_batches")).toEqual([{ id: "history" }]);
          expect(
            await rows("SELECT active_database_id,revision FROM log_database_settings"),
          ).toEqual([{ active_database_id: null, revision: 1 }]);
          expect(await rows("SELECT * FROM run_batch_log_storage")).toEqual([]);
        } finally {
          sqlite?.close();
          if (postgres) {
            await postgres.query("SET search_path TO public");
            await postgres.query(`DROP SCHEMA ${namespace} CASCADE`);
            await postgres.end();
          }
        }
      }, 30000);
    },
  );
}
