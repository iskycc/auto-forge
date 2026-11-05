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
    `${dialect} AI stack analysis upgrade`,
    () => {
      it("preserves legacy AI jobs and resumes cleanly after failed stack-strategy migration", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "ai-stack-upgrade-"));
        const sqlite =
          dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
        let admin: Client | undefined;
        let client: Client | undefined;
        const databaseName = `ai_stack_upgrade_${randomUUID().replaceAll("-", "")}`;
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
          const migrationName = files.find((file) => file.endsWith("_ai_stack_groups.sql"))!;
          for (const file of files.filter((file) => file < migrationName))
            await execute(await readFile(resolve(folder, file), "utf8"));
          await execute(`INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES ('old-ai-batch','old-suite','旧批次',1,'failed',0,1,'[]','2026-11-04','2026-11-04');
          INSERT INTO ai_analysis_jobs(id,batch_id,project_id,requested_by,request_key,status,created_at,updated_at) VALUES ('old-ai-job','old-ai-batch','p','u','key','analyzing','2026-11-04','2026-11-04');
          INSERT INTO ai_analysis_groups(id,job_id,signature,member_count,available_at,updated_at) VALUES ('old-ai-group','old-ai-job','stack',3,'2026-11-04','2026-11-04');`);
          const migration = await readFile(resolve(folder, migrationName), "utf8");
          await execute("BEGIN");
          await expect(
            execute(`${migration}\nSELECT * FROM missing_ai_stack_migration;`),
          ).rejects.toThrow();
          await execute("ROLLBACK");
          await expect(rows("SELECT strategy FROM ai_analysis_jobs")).rejects.toThrow();
          await execute("BEGIN");
          await execute(migration);
          await execute("COMMIT");
          expect(await rows("SELECT strategy,status FROM ai_analysis_jobs")).toEqual([
            { strategy: "legacy", status: "analyzing" },
          ]);
          expect(
            await rows(
              "SELECT member_count,part_cursor,publication_cursor FROM ai_analysis_groups",
            ),
          ).toEqual([{ member_count: 3, part_cursor: 0, publication_cursor: "" }]);
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
