import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformOperationsRepository } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const analyticsQuery = {
  filter: { suiteId: "analytics-snapshot-suite" },
  generatedAt: "2026-09-22T00:00:00.000Z",
};
const replaceFact = `UPDATE analytics_facts SET passed=7,duration_ms=9000
  WHERE attempt_id='analytics-snapshot-attempt'`;

type Fixture = {
  repository: PlatformOperationsRepository;
  afterTotalsRead(operation: () => Promise<void> | void): () => void;
  replaceFact(): Promise<void> | void;
  seedMixedOutcomes(): Promise<void> | void;
  close(): Promise<void> | void;
};

for (const mode of ["sqlite", "postgres"] as const) {
  describe.skipIf(mode === "postgres" && !postgresUrl)(`${mode} analytics read consistency`, () => {
    let fixture: Fixture;
    beforeEach(async () => {
      fixture = mode === "sqlite" ? await sqliteFixture() : await postgresFixture();
    }, 30_000);
    afterEach(async () => {
      await fixture?.close();
    });

    it("finds mixed execution outcomes even when every individual attempt has only passed or failed methods", async () => {
      await fixture.seedMixedOutcomes();
      const summary = await fixture.repository.readAnalytics(analyticsQuery);
      expect(summary.flakyCases).toEqual([
        expect.objectContaining({
          caseDefinitionId: "analytics-snapshot-case",
          samples: 7,
          passed: 4,
          failed: 3,
        }),
      ]);
      const failedOnly = await fixture.repository.readAnalytics({
        ...analyticsQuery,
        filter: { ...analyticsQuery.filter, outcome: "failed" },
      });
      expect(failedOnly.flakyCases).toEqual([]);
    });

    it.each(["overview", "complete"] as const)(
      "keeps the %s snapshot consistent while a different connection publishes facts",
      async (scope) => {
        let published = false;
        const stopIntercepting = fixture.afterTotalsRead(() => {
          published = true;
          return fixture.replaceFact();
        });
        const read = () =>
          scope === "overview"
            ? fixture.repository.readAnalyticsOverview(analyticsQuery)
            : fixture.repository.readAnalytics(analyticsQuery);
        try {
          const before = await read();
          expect(published).toBe(true);
          expect(before).toMatchObject({
            sampleCount: 1,
            passed: 1,
            trend: [{ total: 1, passed: 1 }],
          });
          if (scope === "complete") {
            expect(before.durationP95Ms).toBe(100);
          }
          stopIntercepting();
          const after = await read();
          expect(after).toMatchObject({ passed: 7, trend: [{ total: 7, passed: 7 }] });
          if (scope === "complete") expect(after.durationP95Ms).toBe(9000);
        } finally {
          stopIntercepting();
        }
      },
    );
  });
}

describe.skipIf(!postgresUrl)("PostgreSQL analytics fact publication", () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  beforeEach(async () => {
    fixture = await postgresFixture();
  }, 30_000);
  afterEach(async () => {
    await fixture?.close();
  });

  it("includes completed attempts while another connection holds a non-key row lock", async () => {
    try {
      await fixture.writer.query("DELETE FROM analytics_facts");
      await fixture.writer.query("BEGIN");
      await fixture.writer.query(
        "SELECT id FROM run_attempts WHERE id='analytics-snapshot-attempt' FOR NO KEY UPDATE",
      );
      // A read-only projection must not skip a committed completion because maintenance owns a lock.
      await expect(fixture.repository.readAnalytics(analyticsQuery)).resolves.toMatchObject({
        sampleCount: 1,
        passed: 1,
        trend: [{ total: 1, passed: 1 }],
      });
    } finally {
      await fixture.writer.query("ROLLBACK");
    }
  });
});

async function sqliteFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "analytics-snapshot-"));
  const handle = createSqliteDatabase({
    databasePath: join(directory, "platform.sqlite"),
    migrationsFolder: resolve("packages/db/drizzle/sqlite"),
  });
  const writer = new Database(handle.client.name);
  writer.pragma("busy_timeout=0");
  const repository = new SqlitePlatformOperationsRepository(handle);
  handle.client.exec(seedSql());
  await repository.rebuildAnalyticsFacts(10);
  return {
    repository,
    afterTotalsRead(operation) {
      const prepare = handle.client.prepare.bind(handle.client);
      let intercepted = false;
      const spy = vi.spyOn(handle.client, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (!isTotalsQuery(sql)) return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property !== "get") return Reflect.get(target, property);
            return (...parameters: unknown[]) => {
              const totals = Reflect.apply(target.get, target, parameters);
              if (!intercepted) {
                intercepted = true;
                operation();
              }
              return totals;
            };
          },
        });
      });
      return () => spy.mockRestore();
    },
    replaceFact: () => {
      writer.exec(replaceFact);
    },
    seedMixedOutcomes: () => {
      writer.exec(mixedOutcomeSql());
    },
    close() {
      writer.close();
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function postgresFixture() {
  const schema = `analytics_snapshot_${randomUUID().replaceAll("-", "")}`;
  const administrator = new Pool({ connectionString: postgresUrl!, max: 1 });
  await administrator.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(postgresUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve("packages/db/drizzle/postgresql"),
    poolMax: 2,
  });
  await handle.ready;
  const reader = await handle.pool.connect();
  const writer = await handle.pool.connect();
  let observeQuery: PoolClient["query"] = reader.query.bind(reader);
  // Pin reads to a real connection, including transactions; the second connection commits independently.
  const readConnection = new Proxy(reader, {
    get(target, property) {
      if (property === "query") return observeQuery;
      if (property === "release") return () => {};
      return Reflect.get(target, property);
    },
  });
  const pool = new Proxy(handle.pool, {
    get(target, property) {
      if (property === "query") return observeQuery;
      if (property === "connect") return async () => readConnection;
      return Reflect.get(target, property);
    },
  });
  const repository = new PostgresPlatformOperationsRepository({ ...handle, pool });
  await writer.query(seedSql());
  await repository.rebuildAnalyticsFacts(10);
  return {
    repository,
    writer,
    afterTotalsRead(operation: () => Promise<void> | void) {
      const query = reader.query.bind(reader);
      let publication: Promise<void> | undefined;
      observeQuery = (async (sql: string, values?: unknown[]) => {
        if (publication) await publication;
        const result = query(sql, values);
        if (!publication && isTotalsQuery(sql)) {
          publication = result.then(async () => {
            await operation();
          });
          await publication;
        }
        return result;
      }) as PoolClient["query"];
      return () => {
        observeQuery = query;
      };
    },
    replaceFact: async () => {
      await writer.query(replaceFact);
    },
    seedMixedOutcomes: async () => {
      await writer.query(mixedOutcomeSql());
    },
    async close() {
      reader.release();
      writer.release();
      await handle.close();
      try {
        await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await administrator.end();
      }
    },
  };
}

function isTotalsQuery(sql: string) {
  return sql.includes("SUM(passed),0") && sql.includes("sampleCount");
}

function mixedOutcomeSql(): string {
  return Array.from({ length: 6 }, (_, index) => {
    const failed = index % 2 === 0;
    const outcome = failed ? "failed" : "succeeded";
    const resultCode = failed ? "TESTNG_ASSERTIONS_FAILED" : "TESTNG_SUCCEEDED";
    const report = JSON.stringify({
      total: 1,
      passed: failed ? 0 : 1,
      failed: failed ? 1 : 0,
      skipped: 0,
      configurationFailures: 0,
      detailsTruncated: true,
      suites: [],
    });
    return `INSERT INTO run_attempts
      (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at,finished_at,
       outcome,result_code,result_summary,duration_ms,testng_result_json)
      VALUES ('mixed-attempt-${index}','analytics-snapshot-run','analytics-snapshot-runner',${index + 2},
        '${outcome}',1,'2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z',
        '${outcome}','${resultCode}','${outcome}',100,'${report}');`;
  }).join("\n");
}

function seedSql() {
  return `
    INSERT INTO runners
      (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,
       labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,terminal_enabled,created_at,updated_at)
    VALUES ('analytics-snapshot-runner','hash','Runner',FALSE,FALSE,'linux','amd64','1.17.19',1,
            '[]','[]',1,0,'2026-09-22T00:00:00.000Z',FALSE,'2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z');
    INSERT INTO run_batches
      (id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,secret_bindings_json,
       total_runs,project_id,priority,created_at,updated_at)
    VALUES ('analytics-snapshot-batch','analytics-snapshot-suite','Analytics',1,'succeeded',0,'[]','[]',1,
            '00000000-0000-7000-8000-000000000001',0,'2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z');
    INSERT INTO execution_runs
      (id,batch_id,case_definition_id,case_version,display_name,class_name,parameters_json,status,
       attempt_count,created_at,updated_at)
    VALUES ('analytics-snapshot-run','analytics-snapshot-batch','analytics-snapshot-case',1,'Example Test',
            'com.example.Test','{}','succeeded',1,'2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z');
    INSERT INTO run_attempts
      (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at,finished_at,
       outcome,result_code,result_summary,duration_ms,testng_result_json)
    VALUES ('analytics-snapshot-attempt','analytics-snapshot-run','analytics-snapshot-runner',1,'succeeded',1,
            '2026-09-22T00:00:00.000Z','2026-09-22T00:00:00.000Z','succeeded','TESTNG_SUCCEEDED','passed',100,
            '{"total":1,"passed":1,"failed":0,"skipped":0,"configurationFailures":0,"detailsTruncated":true,"suites":[]}');
  `;
}
