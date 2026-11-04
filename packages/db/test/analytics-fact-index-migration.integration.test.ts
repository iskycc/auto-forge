import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { seedLargeExecutionOverview } from "./fixtures/large-execution-overview";

const indexNames = [
  "analytics_facts_batch_idx",
  "analytics_facts_run_idx",
  "analytics_facts_runner_idx",
];
for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} analytics fact retention indexes`,
    () => {
      it("preserves existing facts on upgrade and rolls back failed index creation", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "analytics-index-upgrade-"));
        const sqlite =
          dialect === "sqlite" ? new Database(resolve(directory, "db.sqlite")) : undefined;
        const pg = sqlite
          ? undefined
          : new Client({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL });
        const schema = `analytics_index_${randomUUID().replaceAll("-", "")}`;
        const execute = async (statement: string) => {
          if (sqlite) sqlite.exec(statement);
          else await pg!.query(statement);
        };
        const rows = async (statement: string) =>
          sqlite ? sqlite.prepare(statement).all() : (await pg!.query(statement)).rows;
        const indexQuery = sqlite
          ? "SELECT name FROM sqlite_schema WHERE type='index' AND name IN ('analytics_facts_batch_idx','analytics_facts_run_idx','analytics_facts_runner_idx') ORDER BY name"
          : "SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('analytics_facts_batch_idx','analytics_facts_run_idx','analytics_facts_runner_idx') ORDER BY indexname";
        try {
          if (pg) {
            await pg.connect();
            await pg.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
          }
          const folder = resolve("packages/db/drizzle", dialect);
          const files = (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort();
          const target = files.find((name) => name.endsWith("_analytics_fact_foreign_keys.sql"))!;
          for (const file of files.filter((name) => name < target))
            await execute(await readFile(resolve(folder, file), "utf8"));
          await seedLargeExecutionOverview(execute, {
            dialect: dialect === "sqlite" ? "sqlite" : "postgres",
            batchId: "index-batch",
            runnerId: "index-runner",
            suiteId: "index-suite",
            projectId: "00000000-0000-7000-8000-000000000001",
            caseCount: 1,
            roundCount: 1,
            recordedAt: "2026-11-04T00:00:00.000Z",
          });
          await execute(`INSERT INTO analytics_facts(attempt_id,project_id,batch_id,run_id,suite_id,case_definition_id,case_version,runner_id,outcome,passed,completed_at,schema_version)
            SELECT a.id,b.project_id,b.id,r.id,b.suite_id,r.case_definition_id,1,a.runner_id,'succeeded',1,a.finished_at,4
            FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id JOIN run_batches b ON b.id=r.batch_id`);
          expect(await rows(indexQuery)).toEqual([]);
          const facts = await rows(
            "SELECT attempt_id,outcome,passed,schema_version FROM analytics_facts",
          );
          const ddl = await readFile(resolve(folder, target), "utf8");
          await execute("BEGIN");
          await expect(
            execute(ddl + "\nSELECT * FROM missing_analytics_index_fixture;"),
          ).rejects.toThrow();
          await execute("ROLLBACK");
          expect(await rows(indexQuery)).toEqual([]);
          expect(
            await rows("SELECT attempt_id,outcome,passed,schema_version FROM analytics_facts"),
          ).toEqual(facts);
          await execute("BEGIN");
          await execute(ddl);
          await execute("COMMIT");
          expect(await rows(indexQuery)).toEqual(indexNames.map((name) => ({ name })));
          expect(
            await rows("SELECT attempt_id,outcome,passed,schema_version FROM analytics_facts"),
          ).toEqual(facts);
        } finally {
          sqlite?.close();
          if (pg) {
            try {
              await pg.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            } finally {
              await pg.end();
            }
          }
          await rm(directory, { recursive: true, force: true });
        }
      }, 30_000);
    },
  );
}
