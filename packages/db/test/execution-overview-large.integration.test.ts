import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import {
  createSqliteDatabase,
  SqliteRunBatchRepository,
  SqlitePlatformOperationsRepository,
} from "@autoforge/db/sqlite";
import {
  createPostgresDatabase,
  PostgresRunBatchRepository,
  PostgresPlatformOperationsRepository,
} from "@autoforge/db/postgres";

import { seedLargeExecutionOverview } from "./fixtures/large-execution-overview";

const recordedAt = "2026-11-04T00:00:00.000Z";
const caseCount = 13_001;
const roundCount = 10;

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} completed large execution statistics`,
    () => {
      it("publishes complete round totals and reads bounded pages within the snapshot query budget", async () => {
        const harness = await database(dialect);
        try {
          await seedLargeExecutionOverview(harness.execute, {
            dialect,
            batchId: "overview-batch",
            runnerId: "overview-runner",
            suiteId: "overview-suite",
            projectId: DEFAULT_PROJECT_ID,
            caseCount,
            roundCount,
            recordedAt,
          });
          const started = performance.now();
          const overview = await harness.batches.getDetailOverview("overview-batch");
          process.stdout.write(
            JSON.stringify({
              dialect,
              caseCount,
              roundCount,
              overviewDurationMs: Math.round(performance.now() - started),
            }) + "\n",
          );
          expect(
            overview?.roundSummaries.map(({ round, totalRuns, executed, passed, failed }) => ({
              round,
              totalRuns,
              executed,
              passed,
              failed,
            })),
          ).toEqual(
            Array.from({ length: roundCount }, (_, index) => ({
              round: index + 1,
              totalRuns: caseCount,
              executed: caseCount,
              passed: index + 1 === roundCount ? caseCount : 0,
              failed: index + 1 === roundCount ? 0 : caseCount,
            })),
          );
          expect(overview?.batch.succeededRuns).toBe(caseCount);
          // Retained production databases have planner statistics; test both fresh and analyzed plans.
          await harness.execute("ANALYZE");
          for (const scope of [1, roundCount, "all", "summary"] as const) {
            for (const sort of ["none", "name", "status", "runner", "duration"] as const) {
              const page = await harness.batches.listCasePage({
                batchId: "overview-batch",
                scope,
                sort,
                direction: "asc",
                offset: 0,
                limit: 50,
              });
              expect(page?.total).toBe(scope === "all" ? caseCount * roundCount : caseCount);
              expect(page?.items).toHaveLength(50);
            }
          }
          // Refreshed table statistics must not turn the remaining candidates into repeated lookups.
          for (let page = 0; page < 5; page++)
            expect(await harness.operations.rebuildAnalyticsFacts(10_000)).toBe(10_000);
          await harness.execute("ANALYZE");
          expect(await harness.operations.rebuildAnalyticsFacts(100)).toBe(100);
          await harness.execute(`DELETE FROM execution_runs WHERE id IN (
            SELECT id FROM execution_runs WHERE batch_id='overview-batch' ORDER BY id LIMIT 1000
          )`);
        } finally {
          await harness.close();
        }
      }, 120_000);
    },
  );
}

async function database(dialect: "sqlite" | "postgres") {
  if (dialect === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "execution-overview-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "platform.sqlite"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    return {
      batches: new SqliteRunBatchRepository(handle),
      operations: new SqlitePlatformOperationsRepository(handle),
      execute: async (statement: string) => {
        handle.client.exec(statement);
      },
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const migrationsFolder = resolve("packages/db/drizzle/postgresql");
  const admin = createPostgresDatabase({
    connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
    migrationsFolder,
    poolMax: 1,
  });
  await admin.ready;
  const schema = `overview_${randomUUID().replaceAll("-", "")}`;
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder,
    poolMax: 1,
    statementTimeoutMs: 2_000,
    lockTimeoutMs: 50,
  });
  await handle.ready;
  return {
    batches: new PostgresRunBatchRepository(handle),
    operations: new PostgresPlatformOperationsRepository(handle),
    execute: async (statement: string) => {
      await handle.pool.query("SET statement_timeout=30000");
      try {
        await handle.pool.query(statement);
      } finally {
        await handle.pool.query("SET statement_timeout=2000");
      }
    },
    close: async () => {
      await handle.close();
      await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}
