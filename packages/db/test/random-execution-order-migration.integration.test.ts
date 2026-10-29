import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(
    `${dialect} random dispatch migration`,
    () => {
      it("preserves history through rollback and upgrade and indexes a hundred thousand queued executions", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "random-dispatch-upgrade-"));
        const sqlite =
          dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
        let admin: Client | undefined;
        let postgres: Client | undefined;
        let databaseName = "";
        try {
          if (!sqlite) {
            admin = new Client({ connectionString: postgresUrl });
            await admin.connect();
            databaseName = `dispatch_upgrade_${randomUUID().replaceAll("-", "")}`;
            await admin.query(`CREATE DATABASE ${databaseName}`);
            const url = new URL(postgresUrl!);
            url.pathname = `/${databaseName}`;
            postgres = new Client({ connectionString: url.toString() });
            await postgres.connect();
          }
          const execute = async (statement: string) => {
            if (sqlite) sqlite.exec(statement);
            else await postgres!.query(statement);
          };
          const rows = async (statement: string): Promise<Record<string, unknown>[]> =>
            sqlite
              ? (sqlite.prepare(statement).all() as Record<string, unknown>[])
              : (await postgres!.query(statement)).rows;
          const folder = resolve("packages/db/drizzle", dialect);
          const files = (await readdir(folder)).filter((file) => file.endsWith(".sql")).sort();
          const migration = files.find((file) =>
            file.endsWith("_random_execution_dispatch_order.sql"),
          )!;
          for (const file of files.filter((file) => file < migration))
            await execute(await readFile(resolve(folder, file), "utf8"));
          await execute(`INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at)
          VALUES ('batch','suite','Random order',1,'queued',0,100000,'[]','2026-10-29','2026-10-29')`);
          const input =
            dialect === "sqlite"
              ? "WITH RECURSIVE source(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM source WHERE n<100000)"
              : "WITH source AS (SELECT generate_series(1,100000) AS n)";
          await execute(`${input} INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at)
          SELECT 'run-'||n,'batch','case-'||n,1,'case-'||n,'example.Case',CASE WHEN n=1 THEN 'succeeded' ELSE 'queued' END,0,'2026-10-29','2026-10-29' FROM source`);
          const migrationSql = await readFile(resolve(folder, migration), "utf8");
          await execute("BEGIN");
          await expect(
            execute(`${migrationSql}\nSELECT * FROM interrupted_dispatch_upgrade;`),
          ).rejects.toThrow();
          await execute("ROLLBACK");
          const columns = () =>
            rows(
              dialect === "sqlite"
                ? "SELECT name FROM pragma_table_info('execution_runs') WHERE name='dispatch_order_key'"
                : "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='execution_runs' AND column_name='dispatch_order_key'",
            );
          expect(await columns()).toEqual([]);
          await execute("BEGIN");
          await execute(migrationSql);
          await execute("COMMIT");
          expect(
            await rows(
              "SELECT status,attempt_count,created_at,dispatch_order_key FROM execution_runs WHERE id='run-1'",
            ),
          ).toEqual([
            {
              status: "succeeded",
              attempt_count: 0,
              created_at: "2026-10-29",
              dispatch_order_key: null,
            },
          ]);
          expect(
            Number((await rows("SELECT count(*) AS count FROM execution_runs"))[0]!.count),
          ).toBe(100000);
          await execute("ANALYZE");
          const query =
            "SELECT id FROM execution_runs WHERE batch_id='batch' AND status='queued' AND held_round=0 ORDER BY coalesce(dispatch_order_key,substr(id,20)),id LIMIT 128";
          const plan = JSON.stringify(
            await rows(
              dialect === "sqlite"
                ? `EXPLAIN QUERY PLAN ${query}`
                : `EXPLAIN (FORMAT JSON) ${query}`,
            ),
          );
          expect(plan).toContain("execution_runs_dispatch_order_idx");
          expect(plan).not.toMatch(/TEMP B-TREE|\"Node Type\":\"Sort\"/);
          expect(await rows(query)).toHaveLength(128);
        } finally {
          sqlite?.close();
          await postgres?.end();
          if (admin) {
            if (databaseName) await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
            await admin.end();
          }
          await rm(directory, { recursive: true, force: true });
        }
      }, 30_000);
    },
  );
}
