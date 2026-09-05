import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  CaseSuiteActivityService,
  DashboardSnapshotService,
  ReadModelSnapshotService,
  ReadModelSnapshotWorker,
  createReadModelBuilder,
  readExecutionOverview,
  readBatchPage,
} from "../../packages/application/src/index";
import { executionCaseKeysSchema, type ReadModelQuery } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import * as sqlite from "@autoforge/db/sqlite";
import * as postgres from "@autoforge/db/postgres";

const timestamp = "2026-09-05T00:00:00.000Z";
const clock = { now: () => new Date(timestamp) };

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} large read models`,
    () => {
      it("publishes 100,000 cases in bounded chunks and serves repeated reads without re-aggregation", async () => {
        const harness = await database(dialect);
        try {
          await harness.execute(`
          INSERT INTO project_versions (id,project_id,name,normalized_name,created_at,updated_at)
            VALUES ('snapshot-version','${DEFAULT_PROJECT_ID}','Snapshot','snapshot','${timestamp}','${timestamp}');
          INSERT INTO test_stages (id,project_id,project_version_id,name,normalized_name,position,created_at,updated_at)
            VALUES ('snapshot-stage','${DEFAULT_PROJECT_ID}','snapshot-version','Stage','stage',1,'${timestamp}','${timestamp}');
          INSERT INTO case_sources (id,project_id,project_version_id,test_stage_id,display_name,original_file_name,object_key,sha256,size_bytes,class_count,method_count,status,warnings_json,inspection_json,created_at,updated_at)
            VALUES ('snapshot-source','${DEFAULT_PROJECT_ID}','snapshot-version','snapshot-stage','Source','source.jar','objects/source','digest',1,100000,0,'ready','[]','{}','${timestamp}','${timestamp}');
          ${dialect === "sqlite" ? "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<100000)" : "WITH numbers(n) AS (SELECT generate_series(1,100000))"}
          INSERT INTO case_definitions (id,source_id,project_id,project_version_id,test_stage_id,class_name,package_name,display_name,enabled,groups_json,current_version,created_at,updated_at)
            SELECT 'case-'||n,'snapshot-source','${DEFAULT_PROJECT_ID}','snapshot-version','snapshot-stage','load.Test'||n,'load','Case '||n,${dialect === "sqlite" ? "1" : "TRUE"},'[]',1,'${timestamp}','${timestamp}' FROM numbers;
        `);
          const suite = await harness.suites.create({
            id: "snapshot-suite",
            projectId: DEFAULT_PROJECT_ID,
            name: "Large suite",
            createdAt: timestamp,
          });
          await harness.execute(`INSERT INTO case_suite_items (id,suite_id,case_definition_id,added_at)
            SELECT id,'${suite.id}',id,'${timestamp}' FROM case_definitions;`);
          const memberPage = await harness.suites.listMemberPage({
            suiteId: suite.id,
            projectIds: [DEFAULT_PROJECT_ID],
            limit: 250,
          });
          expect(memberPage?.items).toHaveLength(250);
          expect(memberPage?.items[0]?.caseDefinition.className).toBeTruthy();
          expect(
            await harness.suites.listMemberPage({
              suiteId: suite.id,
              projectIds: ["forbidden"],
              limit: 250,
            }),
          ).toBeNull();
          const service = new ReadModelSnapshotService(harness.snapshots, clock);
          let builds = 0;
          const builder = createReadModelBuilder({
            ...harness,
            clock,
            dashboard: new DashboardSnapshotService(
              harness.dashboard,
              harness.catalog,
              harness.operations,
              clock,
            ),
            suiteActivity: new CaseSuiteActivityService(
              harness.activity,
              harness.suites,
              harness.batches,
              clock,
            ),
          });
          const errors: unknown[] = [];
          const worker = new ReadModelSnapshotWorker(
            harness.snapshots,
            async (...args) => {
              builds += 1;
              return builder(...args);
            },
            clock,
            { next: randomUUID },
            (error) => errors.push(error),
          );
          const query: ReadModelQuery = {
            kind: "case_directory",
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: "snapshot-version",
            testStageId: "snapshot-stage",
          };
          expect(await service.read(query)).toMatchObject({ state: "pending" });
          const started = performance.now();
          await worker.refreshOne();
          const buildDurationMs = Math.round(performance.now() - started);
          expect(errors).toEqual([]);
          const manifest = await service.read(query);
          expect(manifest.payload).toEqual({ caseCount: 100_000, partCount: 400 });
          expect(JSON.stringify(manifest).length).toBeLessThan(2048);
          const first = (await service.part(manifest.id, manifest.generation!, 0)) as {
            items: unknown[];
          };
          const last = (await service.part(manifest.id, manifest.generation!, 399)) as {
            items: unknown[];
          };
          expect(first.items).toHaveLength(250);
          expect(last.items).toHaveLength(250);
          const readsStarted = performance.now();
          for (let index = 0; index < 100; index++)
            expect((await service.read(query)).generation).toBe(manifest.generation);
          const repeatedReadsDurationMs = Math.round(performance.now() - readsStarted);
          expect(builds).toBe(1);
          expect(await worker.refreshOne()).toBe(false);
          expect(repeatedReadsDurationMs).toBeLessThan(2_000);
          process.stdout.write(
            `${JSON.stringify({ dialect, cases: 100_000, parts: 400, buildDurationMs, repeatedReads: 100, repeatedReadsDurationMs })}\n`,
          );
          const suiteQuery: ReadModelQuery = {
            kind: "suite_directory",
            projectId: DEFAULT_PROJECT_ID,
            suiteId: suite.id,
          };
          await service.read(suiteQuery);
          const suiteStarted = performance.now();
          await worker.refreshOne();
          const suiteManifest = await service.read(suiteQuery);
          expect(suiteManifest.payload).toEqual({
            caseCount: 100_000,
            partCount: 400,
            revision: 1,
          });
          const members = (await service.part(
            suiteManifest.id,
            suiteManifest.generation!,
            399,
          )) as { items: unknown[] };
          expect(members.items).toHaveLength(250);
          expect(JSON.stringify(members)).not.toContain('"methods"');
          const suiteDurationMs = Math.round(performance.now() - suiteStarted);
          await harness.execute(`INSERT INTO run_batches (id,project_id,suite_id,suite_name,suite_version,retry_limit,environment_json,status,total_runs,version,created_at,updated_at,scheduled_for)
            VALUES ('snapshot-batch','${DEFAULT_PROJECT_ID}','${suite.id}','Snapshot',1,0,'[]','succeeded',100000,1,'${timestamp}','${timestamp}','${timestamp}');
            INSERT INTO execution_runs (id,batch_id,case_definition_id,case_version,display_name,class_name,status,terminal_outcome,created_at,updated_at)
            SELECT id,'snapshot-batch',id,1,display_name,class_name,'succeeded','succeeded','${timestamp}','${timestamp}' FROM case_definitions;`);
          await harness.execute(`INSERT INTO runners (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
            VALUES ('snapshot-runner','test','Runner',${dialect === "sqlite" ? "0,0" : "FALSE,FALSE"},'linux','amd64','1.0.0',1,'[]','[]',1,0,'${timestamp}','${timestamp}','${timestamp}');
            INSERT INTO run_attempts (id,execution_run_id,runner_id,attempt_number,status,outcome,scheduling_score,created_at,started_at,finished_at,duration_ms)
            SELECT id,id,'snapshot-runner',1,'succeeded','succeeded',1,'${timestamp}','${timestamp}','${timestamp}',0 FROM execution_runs;`);
          const coldOverview = await readExecutionOverview(
            harness.batches,
            service,
            "snapshot-batch",
          );
          expect(coldOverview.batch.totalRuns).toBe(100_000);
          expect(coldOverview.statistics.state).toBe("pending");
          expect(coldOverview.roundSummaries).toEqual([]);
          await worker.refreshOne();
          expect(errors).toEqual([]);
          const warmOverview = await readExecutionOverview(
            harness.batches,
            service,
            "snapshot-batch",
          );
          expect(warmOverview.batch.succeededRuns).toBe(100_000);
          expect(warmOverview.roundSummaries[0]?.passed).toBe(100_000);
          const batchFilter = { limit: 50, projectIds: [DEFAULT_PROJECT_ID] };
          expect(
            (await readBatchPage(harness.batches, service, batchFilter)).items[0]
              ?.statisticsPending,
          ).toBe(true);
          await worker.refreshOne();
          expect(
            (await readBatchPage(harness.batches, service, batchFilter)).items[0],
          ).toMatchObject({ succeededRuns: 100_000, statisticsPending: false });
          const caseQuery: ReadModelQuery = {
            kind: "execution_case_page",
            projectId: DEFAULT_PROJECT_ID,
            batchId: "snapshot-batch",
            terminalVersion: 1,
            filter: { scope: "summary", sort: "name", direction: "asc", offset: 0, limit: 50 },
          };
          await service.read(caseQuery);
          const caseStarted = performance.now();
          await worker.refreshOne();
          expect(errors).toEqual([]);
          const caseKeys = executionCaseKeysSchema.parse((await service.read(caseQuery)).payload);
          expect(caseKeys.total).toBe(100_000);
          expect(caseKeys.keys).toHaveLength(50);
          const casePageBuildMs = Math.round(performance.now() - caseStarted);
          const entries = await harness.batches.readCasePageEntries(
            "snapshot-batch",
            caseKeys.keys.map((key) => ({
              runId: key.runId,
              round: key.round,
              ...(key.attemptId ? { attemptId: key.attemptId } : {}),
            })),
          );
          expect(entries).toHaveLength(50);
          expect(entries[0]?.attempt?.status).toBe("succeeded");
          expect(
            await harness.batches.readCasePageEntries("forbidden", [
              { runId: entries[0]!.run.id, round: 1 },
            ]),
          ).toEqual([]);
          const readStarted = performance.now();
          for (let index = 0; index < 100; index++) {
            expect(
              (await readExecutionOverview(harness.batches, service, "snapshot-batch")).statistics
                .generation,
            ).toBe(warmOverview.statistics.generation);
            expect((await service.read(suiteQuery)).generation).toBe(suiteManifest.generation);
            expect(
              (await readBatchPage(harness.batches, service, batchFilter)).items[0]?.succeededRuns,
            ).toBe(100_000);
            expect((await service.read(caseQuery)).generation).toBeTruthy();
          }
          expect(builds).toBe(5);
          const warmReadDurationMs = Math.round(performance.now() - readStarted);
          expect(warmReadDurationMs).toBeLessThan(3_000);
          await expect(
            readExecutionOverview(harness.batches, service, "snapshot-batch", ["forbidden"]),
          ).rejects.toMatchObject({ code: "RUN_BATCH_NOT_FOUND" });
          await harness.execute(
            "UPDATE execution_runs SET status='failed',terminal_outcome='failed' WHERE id='case-1'; UPDATE run_batches SET version=2 WHERE id='snapshot-batch'",
          );
          const updated = await readExecutionOverview(harness.batches, service, "snapshot-batch");
          expect(updated.batch).toMatchObject({ status: "succeeded", version: 2 });
          expect(updated.statistics).toMatchObject({ state: "pending", generation: null });
          process.stdout.write(
            `${JSON.stringify({ dialect, suiteMembers: 100000, suiteDurationMs, casePageBuildMs, warmOverviewAndSuiteReads: 100, warmReadDurationMs })}\n`,
          );
        } finally {
          await harness.close();
        }
      });
    },
  );
}

async function database(dialect: "sqlite" | "postgres") {
  if (dialect === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "snapshot-load-"));
    const handle = sqlite.createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../../packages/db/drizzle/sqlite"),
    });
    return {
      statistics: new sqlite.SqlitePlatformStatisticsRepository(handle),
      snapshots: new sqlite.SqliteReadModelSnapshotRepository(handle),
      catalog: new sqlite.SqliteCaseCatalogRepository(handle),
      operations: new sqlite.SqlitePlatformOperationsRepository(handle),
      ddt: new sqlite.SqliteDdtRepository(handle),
      analysis: new sqlite.SqliteFailureAnalysisRepository(handle),
      dashboard: new sqlite.SqliteDashboardSnapshotRepository(handle),
      activity: new sqlite.SqliteCaseSuiteActivityRepository(handle),
      suites: new sqlite.SqliteCaseSuiteRepository(handle),
      batches: new sqlite.SqliteRunBatchRepository(handle),
      execute: async (statement: string) => {
        handle.client.exec(statement);
      },
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const migrationFolder = resolve(import.meta.dirname, "../../packages/db/drizzle/postgresql");
  const admin = postgres.createPostgresDatabase({
    connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
    migrationsFolder: migrationFolder,
  });
  await admin.ready;
  const schema = `snapshot_load_${randomUUID().replaceAll("-", "")}`;
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = postgres.createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: migrationFolder,
  });
  await handle.ready;
  return {
    statistics: new postgres.PostgresPlatformStatisticsRepository(handle),
    snapshots: new postgres.PostgresReadModelSnapshotRepository(handle),
    catalog: new postgres.PostgresCaseCatalogRepository(handle),
    operations: new postgres.PostgresPlatformOperationsRepository(handle),
    ddt: new postgres.PostgresDdtRepository(handle),
    analysis: new postgres.PostgresFailureAnalysisRepository(handle),
    dashboard: new postgres.PostgresDashboardSnapshotRepository(handle),
    activity: new postgres.PostgresCaseSuiteActivityRepository(handle),
    suites: new postgres.PostgresCaseSuiteRepository(handle),
    batches: new postgres.PostgresRunBatchRepository(handle),
    execute: async (statement: string) => {
      await handle.pool.query(statement);
    },
    close: async () => {
      await handle.close();
      await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}
