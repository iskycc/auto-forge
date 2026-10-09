import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { describe, it, expect, vi } from "vitest";
import { RunBatchExportService, buildRunBatchExportRows } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !postgresUrl)(`${dialect} paged result exports`, () => {
    it("preserves final, logical-round and blocked result selection while paging duplicate names", async () => {
      const fixture = await exportDatabase(dialect);
      try {
        const now = "2026-10-10T00:00:00.000Z";
        await fixture.execute(
          `INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES ('runner','hash','runner','linux','amd64','1.19.9',1,'[]',4,0,'${now}','${now}','${now}')`,
        );
        await fixture.execute(
          `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES ('batch','suite','suite',1,'running',3,4,'[]','${now}','${now}')`,
        );
        for (const id of ["a", "b", "c", "d"])
          await fixture.execute(
            `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES ('${id}','batch','case-${id}',1,'Same name','example.SameTest','queued',0,'${now}','${now}')`,
          );
        for (const [id, run, number, round, status, code] of [
          ["a1", "a", 1, 1, "failed", "LEASE_EXPIRED"],
          ["a2", "a", 2, 1, "succeeded", "TESTNG_SUCCEEDED"],
          ["a3", "a", 3, 2, "failed", "TESTNG_ASSERTIONS_FAILED"],
          ["a4", "a", 4, 3, "running", null],
          ["b1", "b", 1, 1, "failed", "ADAPTER_CASE_TIMEOUT"],
          ["b2", "b", 2, 2, "cancelled", "RUN_CANCELLED"],
          ["d1", "d", 1, 1, "failed", "TESTNG_ASSERTIONS_FAILED"],
        ] as const)
          await fixture.execute(
            `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,outcome,result_code,result_summary,scheduling_score,created_at) VALUES ('${id}','${run}','runner',${number},${round},'${status}',${status === "running" ? "NULL" : `'${status}'`},${code ? `'${code}'` : "NULL"},'reason',1,'${now}')`,
          );
        const details = await fixture.batches.get("batch");
        expect(details).not.toBeNull();
        const before = fixture.statements().length;
        const metadata = await fixture.batches.listMetadataPage({ limit: 10 });
        expect(metadata.items.map((batch) => batch.id)).toContain("batch");
        expect(
          fixture
            .statements()
            .slice(before)
            .filter((statement) => statement.includes("run_batches"))
            .some((statement) => statement.includes("adapter_runtime_json")),
        ).toBe(false);
        for (const scope of ["final", "all", "round"] as const) {
          const query = {
            batchId: "batch",
            scope,
            round: 1,
            outcomes: ["succeeded", "failed", "blocked", "timed_out", "cancelled"] as const,
          };
          const prepared = await new RunBatchExportService(fixture.batches).prepare(query);
          const actual = [];
          for await (const rows of prepared.pages) actual.push(...rows);
          expect(actual.map((row) => row.attemptId).sort()).toEqual(
            buildRunBatchExportRows(details!, query)
              .map((row) => row.attemptId)
              .sort(),
          );
          const candidateIds: string[] = [];
          let after: import("@autoforge/application").RunBatchExportCursor | undefined;
          do {
            const page = await fixture.batches.readExportPage({
              batchId: "batch",
              scope,
              round: 1,
              limit: 1,
              ...(after ? { after } : {}),
            });
            expect(page.items.length).toBeLessThanOrEqual(1);
            candidateIds.push(...page.items.map((item) => item.attempt.id));
            after = page.next;
          } while (after);
          expect(new Set(candidateIds).size).toBe(candidateIds.length);
          expect(candidateIds).not.toContain("a1");
          expect(candidateIds).not.toContain("c");
        }
      } finally {
        await fixture.close();
      }
    });
    it("pages 100,000 results without loading execution snapshots or losing cursor rows", async () => {
      const fixture = await exportDatabase(dialect);
      try {
        const now = "2026-10-10T00:00:00.000Z";
        await fixture.execute(
          `INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES ('runner','hash','runner','linux','amd64','1.19.9',1,'[]',4,0,'${now}','${now}','${now}')`,
        );
        await fixture.execute(
          `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES ('capacity','suite','suite',1,'failed',0,100000,'[]','${now}','${now}')`,
        );
        const sequence =
          dialect === "sqlite"
            ? "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<100000)"
            : "WITH numbers AS (SELECT generate_series(1,100000) AS n)";
        const padded =
          dialect === "sqlite" ? "substr('000000'||CAST(n AS TEXT),-6)" : "lpad(n::text,6,'0')";
        await fixture.execute(`${sequence}
          INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at)
          SELECT 'run-'||${padded},'capacity','case-'||${padded},1,'Case '||${padded},'example.CapacityTest','failed',1,'${now}','${now}' FROM numbers`);
        await fixture.execute(`INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,outcome,result_code,scheduling_score,created_at)
          SELECT 'attempt-'||id,id,'runner',1,1,'failed','failed','TESTNG_ASSERTIONS_FAILED',1,'${now}' FROM execution_runs WHERE batch_id='capacity'`);
        const statementCount = fixture.statements().length;
        let after: import("@autoforge/application").RunBatchExportCursor | undefined;
        let exported = 0;
        do {
          const page = await fixture.batches.readExportPage({
            batchId: "capacity",
            scope: "final",
            limit: 200,
            ...(after ? { after } : {}),
          });
          expect(page.items).toHaveLength(200);
          expect(page.items.map((item) => item.run.id)).toEqual(
            Array.from(
              { length: 200 },
              (_, index) => `run-${String(exported + index + 1).padStart(6, "0")}`,
            ),
          );
          exported += page.items.length;
          after = page.next;
        } while (after);
        expect(exported).toBe(100000);
        const reads = fixture.statements().slice(statementCount);
        expect(reads).toHaveLength(500);
        for (const statement of reads) {
          expect(statement).not.toMatch(
            /class_data_json|testng_result_json|adapter_runtime_json|SELECT \*/i,
          );
        }
      } finally {
        await fixture.close();
      }
    }, 180_000);
  });

async function exportDatabase(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(join(tmpdir(), "run-export-pages-"));
  if (dialect === "sqlite") {
    const handle = createSqliteDatabase({
      databasePath: join(directory, "platform.sqlite"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    const queries = vi.spyOn(handle.client, "prepare");
    return {
      batches: new SqliteRunBatchRepository(handle),
      statements: () => queries.mock.calls.map(([statement]) => statement),
      execute: async (statement: string) => {
        handle.client.exec(statement);
      },
      close: async () => {
        queries.mockRestore();
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const name = `export_pages_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve("packages/db/drizzle/postgresql"),
    poolMax: 1,
  });
  await handle.ready;
  const queries = vi.spyOn(handle.pool, "query");
  return {
    batches: new PostgresRunBatchRepository(handle),
    statements: () =>
      queries.mock.calls.map(([statement]) =>
        typeof statement === "string" ? statement : (statement as { text: string }).text,
      ),
    execute: async (statement: string) => {
      await handle.pool.query(statement);
    },
    close: async () => {
      queries.mockRestore();
      await handle.close();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
