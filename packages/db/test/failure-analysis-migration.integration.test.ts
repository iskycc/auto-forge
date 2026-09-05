import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} analysis activation migration`,
    () => {
      it("preserves worked-on batches, leaves untouched executions hidden and rolls back failed upgrades", async () => {
        const database = await legacyDatabase(dialect);
        const folder = resolve(
          import.meta.dirname,
          `../drizzle/${dialect === "sqlite" ? "sqlite" : "postgresql"}`,
        );
        const migrationName =
          dialect === "sqlite"
            ? "0063_failure_analysis_batches.sql"
            : "0062_failure_analysis_batches.sql";
        try {
          for (const file of (await readdir(folder))
            .filter((name) => name.endsWith(".sql") && name < migrationName)
            .sort()) {
            await database.execute(await readFile(resolve(folder, file), "utf8"));
          }
          const disabled = dialect === "sqlite" ? "0" : "FALSE";
          await database.execute(`
          INSERT INTO runners (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
          VALUES ('runner','hash','Runner',${disabled},${disabled},'linux','amd64','1.0.0',1,'[]','[]',1,0,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
          INSERT INTO run_batches (id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,created_at,updated_at)
          VALUES ('worked','suite','Worked',1,'succeeded',0,'[]',1,'00000000-0000-7000-8000-000000000001','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),
                 ('untouched','suite','Untouched',1,'succeeded',0,'[]',1,'00000000-0000-7000-8000-000000000001','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
          INSERT INTO execution_runs (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at)
          VALUES ('run','worked','case',1,'Case','example.Case','failed',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
          INSERT INTO run_attempts (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at)
          VALUES ('attempt','run','runner',1,'failed',1,'2026-09-01T00:00:00.000Z');
          INSERT INTO failure_analysis_claims (id,project_id,batch_id,execution_run_id,case_definition_id,attempt_id,case_name,class_name,attempt_number,failure_summary,status,claimant_id,claimant_username,claimant_display_name,claimed_at,updated_at)
          VALUES ('analysis','00000000-0000-7000-8000-000000000001','worked','run','case','attempt','Case','example.Case',1,'Failed','claimed','analyst','analyst','Analyst','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z');
        `);
          const migration = await readFile(resolve(folder, migrationName), "utf8");
          await database.execute("BEGIN");
          await database.execute(migration);
          await expect(
            database.execute("SELECT * FROM intentionally_missing_upgrade_table"),
          ).rejects.toThrow();
          await database.execute("ROLLBACK");
          await expect(database.query("SELECT * FROM failure_analysis_batches")).rejects.toThrow();
          await database.execute("BEGIN");
          await database.execute(migration);
          await database.execute("COMMIT");
          expect(
            await database.query("SELECT batch_id,started_at FROM failure_analysis_batches"),
          ).toEqual([{ batch_id: "worked", started_at: "2026-09-01T01:00:00.000Z" }]);
          expect(await database.query("SELECT id FROM failure_analysis_claims")).toEqual([
            { id: "analysis" },
          ]);
        } finally {
          await database.dispose();
        }
      });
    },
  );
}

async function legacyDatabase(dialect: "sqlite" | "postgres") {
  if (dialect === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "analysis-migration-"));
    const database = new DatabaseSync(resolve(directory, "legacy.sqlite"));
    database.exec("PRAGMA foreign_keys = ON");
    return {
      execute: async (statement: string) => {
        database.exec(statement);
      },
      query: async (statement: string) => database.prepare(statement).all(),
      dispose: async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const databaseName = `analysis_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const connectionString = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  connectionString.pathname = `/${databaseName}`;
  const client = new Client({ connectionString: connectionString.toString() });
  await client.connect();
  return {
    execute: async (statement: string) => {
      await client.query(statement);
    },
    query: async (statement: string) =>
      (await client.query<Record<string, unknown>>(statement)).rows,
    dispose: async () => {
      await client.end();
      await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      await admin.end();
    },
  };
}
