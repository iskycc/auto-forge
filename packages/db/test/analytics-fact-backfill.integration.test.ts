import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createPostgresDatabase, runPostgresMigrations } from "../src/postgres-database";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";
import { seedLargeExecutionOverview } from "./fixtures/large-execution-overview";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;

it.skipIf(!postgresUrl)(
  "resumes a bounded analytics history backfill after a PostgreSQL upgrade",
  async () => {
    const migrationsFolder = resolve("packages/db/drizzle/postgresql");
    const target = "0104_analytics_fact_pending.sql";
    const previousMigrations = await mkdtemp(resolve(tmpdir(), "analytics-backfill-upgrade-"));
    const schema = `analytics_backfill_${randomUUID().replaceAll("-", "")}`;
    const administrator = new Pool({ connectionString: postgresUrl!, max: 1 });
    const url = new URL(postgresUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    let previous: ReturnType<typeof createPostgresDatabase> | undefined;
    let worker: ReturnType<typeof createPostgresDatabase> | undefined;
    let replacement: ReturnType<typeof createPostgresDatabase> | undefined;
    try {
      for (const file of (await readdir(migrationsFolder)).filter(
        (name) => /^\d+_.+\.sql$/u.test(name) && name < target,
      ))
        await copyFile(resolve(migrationsFolder, file), resolve(previousMigrations, file));
      await administrator.query(`CREATE SCHEMA ${schema}`);
      previous = createPostgresDatabase({
        connectionString: url.toString(),
        migrationsFolder: previousMigrations,
        poolMax: 1,
      });
      await previous.ready;
      const pool = previous.pool;
      await seedLargeExecutionOverview((sql) => pool.query(sql), {
        dialect: "postgres",
        batchId: "backfill-batch",
        runnerId: "backfill-runner",
        suiteId: "backfill-suite",
        projectId: DEFAULT_PROJECT_ID,
        caseCount: 5_001,
        roundCount: 1,
        recordedAt: "2026-11-01T00:00:00.000Z",
      });
      const last = (
        await pool.query<{ id: string }>(`SELECT id FROM run_attempts ORDER BY id DESC LIMIT 3`)
      ).rows;
      const missing = last[0]!.id;
      const oldVersion = last[1]!.id;
      const pending = last[2]!.id;
      await pool.query(
        `INSERT INTO analytics_facts(attempt_id,project_id,batch_id,run_id,suite_id,case_definition_id,case_version,runner_id,outcome,passed,completed_at,schema_version)
       SELECT a.id,b.project_id,b.id,r.id,b.suite_id,r.case_definition_id,1,a.runner_id,'succeeded',1,a.finished_at,
              CASE WHEN a.id=$2 THEN 3 ELSE 4 END
       FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id JOIN run_batches b ON b.id=r.batch_id
       WHERE a.id<>$1 AND a.id<>$3`,
        [missing, oldVersion, pending],
      );
      await pool.query(
        "UPDATE run_attempts SET status='running',finished_at=NULL,outcome=NULL WHERE id=$1",
        [pending],
      );
      const migration = await readFile(resolve(migrationsFolder, target), "utf8");
      const session = await pool.connect();
      try {
        await session.query("BEGIN");
        await expect(
          session.query(`${migration}\nSELECT * FROM invalid_backfill_migration_fixture;`),
        ).rejects.toMatchObject({ code: "42P01" });
        await session.query("ROLLBACK");
        expect(
          (await session.query(`SELECT to_regclass('analytics_fact_pending') AS pending`)).rows,
        ).toEqual([{ pending: null }]);
      } finally {
        session.release();
      }
      await runPostgresMigrations(pool, migrationsFolder);
      expect(
        (await pool.query("SELECT COUNT(*)::integer AS count FROM analytics_facts")).rows[0]?.count,
      ).toBe(4_999);
      expect((await pool.query("SELECT attempt_id FROM analytics_fact_pending")).rows).toEqual([]);
      worker = createPostgresDatabase({
        connectionString: url.toString(),
        migrationsFolder,
        poolMax: 1,
        statementTimeoutMs: 2_000,
        lockTimeoutMs: 50,
      });
      const firstPublisher = new PostgresPlatformOperationsRepository(worker);
      await expect(firstPublisher.tryRebuildAnalyticsFacts(100)).resolves.toEqual({
        status: "updated",
        count: 0,
        moreWork: true,
      });
      const firstCursor = (await pool.query("SELECT after_attempt_id FROM analytics_fact_backfill"))
        .rows[0]?.after_attempt_id;
      expect(firstCursor).toBe(
        (await pool.query("SELECT id FROM run_attempts ORDER BY id OFFSET 1999 LIMIT 1")).rows[0]
          ?.id,
      );
      await worker.close();
      worker = undefined;

      replacement = createPostgresDatabase({
        connectionString: url.toString(),
        migrationsFolder,
        poolMax: 1,
        statementTimeoutMs: 2_000,
        lockTimeoutMs: 50,
      });
      const publisher = new PostgresPlatformOperationsRepository(replacement);
      await expect(publisher.tryRebuildAnalyticsFacts(100)).resolves.toEqual({
        status: "updated",
        count: 0,
        moreWork: true,
      });
      const secondCursor = (
        await pool.query("SELECT after_attempt_id FROM analytics_fact_backfill")
      ).rows[0]?.after_attempt_id;
      expect(secondCursor).toBe(
        (await pool.query("SELECT id FROM run_attempts ORDER BY id OFFSET 3999 LIMIT 1")).rows[0]
          ?.id,
      );
      await expect(publisher.tryRebuildAnalyticsFacts(100)).resolves.toEqual({
        status: "updated",
        count: 2,
      });
      const backfilled = await pool.query(
        "SELECT attempt_id,schema_version FROM analytics_facts WHERE attempt_id=ANY($1) ORDER BY attempt_id",
        [[missing, oldVersion]],
      );
      expect(backfilled.rows).toEqual([
        { attempt_id: oldVersion, schema_version: 4 },
        { attempt_id: missing, schema_version: 4 },
      ]);

      await pool.query(
        "UPDATE run_attempts SET status='succeeded',finished_at=created_at,outcome='succeeded' WHERE id=$1",
        [pending],
      );
      await expect(publisher.tryRebuildAnalyticsFacts(100)).resolves.toEqual({
        status: "updated",
        count: 1,
      });
      await expect(publisher.tryRebuildAnalyticsFacts(100)).resolves.toEqual({
        status: "updated",
        count: 0,
      });
      expect(
        (await pool.query("SELECT COUNT(*)::integer AS count FROM analytics_facts")).rows[0]?.count,
      ).toBe(5_001);
    } finally {
      await worker?.close();
      await replacement?.close();
      await previous?.close();
      try {
        await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await administrator.end();
        await rm(previousMigrations, { recursive: true, force: true });
      }
    }
  },
  45_000,
);
