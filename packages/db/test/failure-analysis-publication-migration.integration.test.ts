import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(
    `${dialect} public analysis upgrade`,
    () => {
      it("upgrades existing analyses without publishing history and recovers after failed migration", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "analysis-public-upgrade-"));
        const sqlite =
          dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
        let admin: Client | undefined;
        let client: Client | undefined;
        const databaseName = `analysis_upgrade_${randomUUID().replaceAll("-", "")}`;
        try {
          if (!sqlite) {
            admin = new Client({ connectionString: postgresUrl });
            await admin.connect();
            await admin.query(`CREATE DATABASE ${databaseName}`);
            const url = new URL(postgresUrl!);
            url.pathname = `/${databaseName}`;
            client = new Client({ connectionString: url.toString() });
            await client.connect();
          }
          const execute = async (sql: string) => {
            if (sqlite) sqlite.exec(sql);
            else await client!.query(sql);
          };
          const rows = async (sql: string) =>
            sqlite ? sqlite.prepare(sql).all() : (await client!.query(sql)).rows;
          const folder = resolve(import.meta.dirname, "../drizzle", dialect);
          const files = (await readdir(folder)).filter((file) => file.endsWith(".sql")).sort();
          const migrationName = files.find((file) =>
            file.endsWith("_public_failure_analysis.sql"),
          )!;
          for (const file of files.filter((file) => file < migrationName))
            await execute(await readFile(resolve(folder, file), "utf8"));
          await execute(`INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES ('old-analysis-batch','old-suite','历史批次',1,'failed',0,1,'[]','2026-11-04','2026-11-04');
          INSERT INTO failure_analysis_batches(batch_id,project_id,started_by,started_at) VALUES ('old-analysis-batch','00000000-0000-7000-8000-000000000001','old-actor','2026-11-04');`);
          const migration = await readFile(resolve(folder, migrationName), "utf8");
          await execute("BEGIN");
          await expect(
            execute(`${migration}\nSELECT * FROM missing_public_analysis_migration;`),
          ).rejects.toThrow();
          await execute("ROLLBACK");
          await expect(rows("SELECT * FROM public_failure_analysis_links")).rejects.toThrow();
          await execute("BEGIN");
          await execute(migration);
          await execute("COMMIT");
          expect(await rows("SELECT * FROM public_failure_analysis_links")).toEqual([]);
          expect(await rows("SELECT batch_id,started_by FROM failure_analysis_batches")).toEqual([
            { batch_id: "old-analysis-batch", started_by: "old-actor" },
          ]);
        } finally {
          sqlite?.close();
          await client?.end();
          if (admin) {
            try {
              await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
            } finally {
              await admin.end();
            }
          }
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  );
