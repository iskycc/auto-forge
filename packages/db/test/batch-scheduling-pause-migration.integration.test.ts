import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(
    `${dialect} scheduling pause upgrade`,
    () => {
      it("rolls back interrupted DDL and upgrades existing batches without changing results", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "autoforge-pause-upgrade-"));
        const sqlite =
          dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
        const postgres = sqlite ? undefined : new Client({ connectionString: postgresUrl });
        const schema = `pause_upgrade_${randomUUID().replaceAll("-", "")}`;
        const execute = async (sql: string) => {
          if (sqlite) sqlite.exec(sql);
          else await postgres!.query(sql);
        };
        const rows = async (sql: string) =>
          sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        try {
          if (postgres) {
            await postgres.connect();
            await postgres.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
          }
          const folder = resolve("packages/db/drizzle", dialect);
          const files = (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort();
          const target = files.find((name) => name.endsWith("_batch_scheduling_pause.sql"))!;
          for (const file of files.filter((name) => name < target))
            await execute(await readFile(resolve(folder, file), "utf8"));
          await execute(
            "INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES ('history','suite','History',1,'succeeded',0,1,'[]','2026-10-29','2026-10-29')",
          );
          const ddl = await readFile(resolve(folder, target), "utf8");
          await execute("BEGIN");
          await expect(execute(`${ddl}\nSELECT * FROM invalid_pause_upgrade;`)).rejects.toThrow();
          await execute("ROLLBACK");
          const columns = () =>
            rows(
              sqlite
                ? "SELECT name FROM pragma_table_info('run_batches') WHERE name='pause_requested_at'"
                : `SELECT column_name FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='run_batches' AND column_name='pause_requested_at'`,
            );
          expect(await columns()).toEqual([]);
          await execute("BEGIN");
          await execute(ddl);
          await execute("COMMIT");
          expect(await columns()).toHaveLength(1);
          expect(
            await rows(
              "SELECT status,total_runs,pause_requested_at,queue_resumed_at FROM run_batches WHERE id='history'",
            ),
          ).toEqual([
            {
              status: "succeeded",
              total_runs: 1,
              pause_requested_at: null,
              queue_resumed_at: null,
            },
          ]);
        } finally {
          sqlite?.close();
          if (postgres) {
            try {
              await postgres.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            } finally {
              await postgres.end();
            }
          }
          await rm(directory, { recursive: true, force: true });
        }
      }, 30000);
    },
  );
}
