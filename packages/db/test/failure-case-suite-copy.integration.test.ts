import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  CaseSuiteService,
  type CaseCatalogRepository,
  type CaseSuiteRepository,
  type ProjectStructureRepository,
  type RunBatchRepository,
  type PlatformOperationsRepository,
  type FailureAnalysisRepository,
} from "@autoforge/application";
import { DEFAULT_PROJECT_ID, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";

import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { SqliteFailureAnalysisRepository } from "../src/sqlite-failure-analysis";
import { PostgresFailureAnalysisRepository } from "../src/postgres-failure-analysis";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";

const timestamp = "2026-10-06T00:00:00.000Z";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;

type Fixture = {
  suites: CaseSuiteRepository;
  batches: RunBatchRepository;
  operations: PlatformOperationsRepository;
  analysis: FailureAnalysisRepository;
  rows: (statement: string) => Promise<Record<string, unknown>[]>;
  execute: (statement: string, parameters?: Array<string | number>) => Promise<void>;
  close: () => Promise<void>;
};

async function fixture(mode: "sqlite" | "postgres", migrationsFolder?: string): Promise<Fixture> {
  if (mode === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-failure-copy-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: migrationsFolder ?? resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    return {
      suites: new SqliteCaseSuiteRepository(handle),
      batches: new SqliteRunBatchRepository(handle),
      operations: new SqlitePlatformOperationsRepository(handle),
      analysis: new SqliteFailureAnalysisRepository(handle),
      rows: async (statement) =>
        handle.client.prepare(statement).all() as Record<string, unknown>[],
      execute: async (statement, parameters = []) => {
        handle.client.prepare(statement).run(...parameters);
      },
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const schema = `failure_copy_${randomUUID().replaceAll("-", "")}`;
  const administration = new Pool({ connectionString: postgresUrl!, max: 1 });
  await administration.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(postgresUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: migrationsFolder ?? resolve(import.meta.dirname, "../drizzle/postgresql"),
    poolMax: migrationsFolder ? 1 : 2,
  });
  await handle.ready;
  return {
    suites: new PostgresCaseSuiteRepository(handle),
    batches: new PostgresRunBatchRepository(handle),
    operations: new PostgresPlatformOperationsRepository(handle),
    analysis: new PostgresFailureAnalysisRepository(handle),
    rows: async (statement) => (await handle.pool.query<Record<string, unknown>>(statement)).rows,
    execute: async (statement, parameters = []) => {
      let index = 0;
      await handle.pool.query(
        statement.replaceAll("?", () => `$${++index}`),
        parameters,
      );
    },
    close: async () => {
      await handle.close();
      await administration.query(`DROP SCHEMA ${schema} CASCADE`);
      await administration.end();
    },
  };
}

async function seed({ suites, execute }: Fixture) {
  await execute(
    "INSERT INTO project_versions (id, project_id, name, normalized_name, created_at, updated_at) VALUES ('version-1', ?, 'V1', 'v1', ?, ?)",
    [DEFAULT_PROJECT_ID, timestamp, timestamp],
  );
  await execute(
    "INSERT INTO test_stages (id, project_id, project_version_id, name, normalized_name, position, created_at, updated_at) VALUES ('stage-1', ?, 'version-1', 'SIT', 'sit', 1, ?, ?)",
    [DEFAULT_PROJECT_ID, timestamp, timestamp],
  );
  await execute(
    "INSERT INTO case_sources (id, display_name, original_file_name, object_key, sha256, size_bytes, class_count, method_count, status, warnings_json, inspection_json, created_at, updated_at) VALUES ('source-1', 'Source', 'source.jar', 'jars/source.jar', ?, 1, 3, 0, 'ready', '[]', '{}', ?, ?)",
    ["a".repeat(64), timestamp, timestamp],
  );
  for (const caseId of ["failure", "timeout", "recovered", "passed", "cancelled"]) {
    await execute(
      "INSERT INTO case_definitions (id, project_version_id, test_stage_id, source_id, class_name, package_name, display_name, enabled, groups_json, current_version, created_at, updated_at) VALUES (?, 'version-1', 'stage-1', 'source-1', ?, 'example', ?, TRUE, '[]', 1, ?, ?)",
      [caseId, `example.${caseId}`, caseId, timestamp, timestamp],
    );
  }
  await execute(
    "INSERT INTO ddt_cases (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized, sr_num, sr_num_normalized, case_kind, data_json, created_at, updated_at) VALUES ('ddt-1', ?, 'version-1', 'stage-1', 'DDT001', 'ddt001', 'SR1', 'sr1', 'standard', '{}', ?, ?)",
    [DEFAULT_PROJECT_ID, timestamp, timestamp],
  );
  const policy = {
    ...defaultCaseSuiteExecutionPolicy,
    projectVersionId: "version-1",
    runnerIds: ["runner-1"],
    concurrency: 17,
    priority: 9,
    retryLimit: 2,
    adapter: {
      enabled: true,
      suiteName: "Suite",
      testName: "Test",
      environmentAddresses: ["https://adapter.internal"],
    },
  };
  await suites.copySuite({
    id: "suite-1",
    name: "Original",
    description: "Original description",
    policy,
    items: [],
    versionId: "suite-snapshot-1",
    createdAt: timestamp,
  });
  await execute(
    "INSERT INTO run_batches (id, suite_id, suite_name, suite_version, status, retry_limit, retry_mode, priority, environment_json, total_runs, project_id, policy_json, created_at, updated_at) VALUES ('batch-1', 'suite-1', 'Original', 1, 'succeeded', 2, 'round', 9, '[]', 6, ?, ?, ?, ?)",
    [
      DEFAULT_PROJECT_ID,
      JSON.stringify({
        concurrency: 17,
        projectVersionId: "version-1",
        runnerLabels: ["java"],
        artifactPatterns: ["reports/**"],
        executor: "testng",
        retryConcurrencyRules: [],
      }),
      timestamp,
      timestamp,
    ],
  );
  for (const [caseId, outcome, caseType] of [
    ["failure", "failed", "testng"],
    ["timeout", "timed_out", "testng"],
    ["recovered", "failed", "testng"],
    ["passed", "succeeded", "testng"],
    ["cancelled", "cancelled", "testng"],
    ["ddt-1", "failed", "ddt"],
  ]) {
    await execute(
      "INSERT INTO execution_runs (id, batch_id, case_definition_id, case_version, display_name, class_name, case_type, status, terminal_outcome, created_at, updated_at) VALUES (?, 'batch-1', ?, 1, ?, 'example.Case', ?, ?, ?, ?, ?)",
      [
        `run-${caseId}`,
        caseId!,
        caseId!,
        caseType!,
        outcome === "timed_out" ? "failed" : outcome!,
        outcome!,
        timestamp,
        timestamp,
      ],
    );
  }
  await execute(
    "INSERT INTO runners (id, credential_hash, name, os, architecture, agent_version, protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots, last_seen_at, created_at, updated_at) VALUES ('runner-1', 'hash', 'Runner', 'linux', 'amd64', '1.0.0', 1, '[]', '[]', 1, 0, ?, ?, ?)",
    [timestamp, timestamp, timestamp],
  );
  for (const [number, outcome] of [
    [1, "failed"],
    [2, "succeeded"],
  ] as const) {
    await execute(
      "INSERT INTO run_attempts (id, execution_run_id, runner_id, attempt_number, status, outcome, scheduling_score, created_at) VALUES (?, 'run-recovered', 'runner-1', ?, ?, ?, 1, ?)",
      [`attempt-${number}`, number, outcome, outcome, timestamp],
    );
  }
  await suites.updateSuite({
    suiteId: "suite-1",
    expectedRevision: 1,
    versionId: "suite-snapshot-2",
    changeReason: "Changed after execution",
    updatedAt: timestamp,
    description: "Changed description",
    policy: {
      ...policy,
      concurrency: 99,
      adapter: { ...policy.adapter, environmentAddresses: ["https://changed.internal"] },
    },
  });
  const service = new CaseSuiteService(
    suites,
    {} as CaseCatalogRepository,
    {
      list: async () => ({
        versions: [{ id: "version-1", projectId: DEFAULT_PROJECT_ID, status: "active" }],
      }),
    } as unknown as ProjectStructureRepository,
    { now: () => new Date(timestamp) },
    { next: randomUUID },
  );
  return { service, policy };
}

for (const mode of ["sqlite", "postgres"] as const) {
  describe.skipIf(mode === "postgres" && !postgresUrl)(`${mode} failure task copy contract`, () => {
    it("upgrades the previous schema without losing snapshots and rolls back failed history DDL", async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "suite-history-upgrade-"));
      const folder = resolve(
        import.meta.dirname,
        `../drizzle/${mode === "sqlite" ? "sqlite" : "postgresql"}`,
      );
      const migration =
        mode === "sqlite"
          ? "0076_preserve_case_suite_history.sql"
          : "0074_preserve_case_suite_history.sql";
      for (const name of (await readdir(folder)).filter(
        (name) => name.endsWith(".sql") && name < migration,
      )) {
        await writeFile(resolve(directory, name), await readFile(resolve(folder, name)));
      }
      const context = await fixture(mode, directory);
      try {
        const { service } = await seed(context);
        const versions = await context.rows("SELECT * FROM case_suite_versions ORDER BY id");
        const batches = await context.rows("SELECT * FROM run_batches ORDER BY id");
        const statements = (await readFile(resolve(folder, migration), "utf8"))
          .split(";")
          .map((statement) => statement.trim())
          .filter(Boolean);
        await context.execute("BEGIN");
        for (const statement of statements) await context.execute(statement);
        await expect(
          context.rows("SELECT * FROM missing_history_migration_table"),
        ).rejects.toThrow();
        await context.execute("ROLLBACK");
        expect(await context.rows("SELECT * FROM case_suite_versions ORDER BY id")).toEqual(
          versions,
        );
        // A rolled-back migration retains the original foreign-key behavior.
        await context.execute("BEGIN");
        await context.execute("DELETE FROM case_suites WHERE id = 'suite-1'");
        expect(await context.rows("SELECT * FROM case_suite_versions")).toEqual([]);
        await context.execute("ROLLBACK");
        await context.execute("BEGIN");
        for (const statement of statements) await context.execute(statement);
        await context.execute("COMMIT");
        expect(await context.rows("SELECT * FROM case_suite_versions ORDER BY id")).toEqual(
          versions,
        );
        await service.delete("suite-1", { expectedRevision: 2 });
        expect(await context.rows("SELECT * FROM case_suite_versions ORDER BY id")).toEqual(
          versions,
        );
        expect(await context.rows("SELECT * FROM run_batches ORDER BY id")).toEqual(batches);
        expect((await service.createFromFinalFailures("batch-1", {})).caseCount).toBe(3);
      } finally {
        await context.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 15_000);

    it("deletes configuration and triggers while retaining mixed execution history and failure-task creation", async () => {
      const context = await fixture(mode);
      try {
        const { service } = await seed(context);
        await seedDeletionAssociations(context);
        const historyTables = [
          "run_batches",
          "execution_runs",
          "run_attempts",
          "run_batch_status_events",
          "run_batch_round_recoveries",
          "attempt_log_watermarks",
          "attempt_artifacts",
          "attempt_log_shares",
          "analytics_facts",
          "case_definitions",
          "ddt_cases",
          "case_suite_versions",
          "webhook_configurations",
        ];
        const before = await Promise.all(
          historyTables.map((table) => context.rows(`SELECT * FROM ${table} ORDER BY 1`)),
        );
        const details = await context.batches.get("batch-1");
        await service.delete("suite-1", { expectedRevision: 2 }, [DEFAULT_PROJECT_ID]);
        expect(await context.suites.getSummary("suite-1")).toBeNull();
        expect(await context.suites.get("suite-1")).toBeNull();
        expect(await context.suites.list(100)).toEqual([]);
        for (const table of [
          "case_suite_items",
          "case_suite_ddt_items",
          "case_suite_pins",
          "case_suite_round_recovery_credentials",
          "case_suite_webhook_bindings",
          "case_suite_schedules",
          "schedule_trigger_claims",
        ]) {
          expect(await context.rows(`SELECT * FROM ${table}`), table).toEqual([]);
        }
        for (const [index, table] of historyTables.entries()) {
          expect(await context.rows(`SELECT * FROM ${table} ORDER BY 1`), table).toEqual(
            before[index],
          );
        }
        expect(await context.batches.get("batch-1")).toEqual(details);
        expect(await context.batches.getSummary("active-batch")).toMatchObject({
          status: "running",
          suiteId: "suite-1",
        });
        expect(await context.operations.listDueSchedules(timestamp, 10)).toEqual([]);
        await expect(context.operations.upsertSchedule(deletionSchedule())).rejects.toMatchObject({
          code: "CASE_SUITE_NOT_FOUND",
        });
        await expect(service.delete("suite-1", { expectedRevision: 2 })).rejects.toMatchObject({
          code: "CASE_SUITE_NOT_FOUND",
        });
        const copy = await service.createFromFinalFailures("batch-1", {});
        expect(copy).toMatchObject({
          caseCount: 3,
          policy: { concurrency: 17 },
          description: "Original description",
        });
        const members = await context.suites.listMemberPage({ suiteId: copy.id, limit: 10 });
        expect(members!.items.map((member) => member.caseDefinition.id).sort()).toEqual([
          "failure",
          "timeout",
        ]);
        expect(members!.ddtItems.map((member) => member.ddtCase.id)).toEqual(["ddt-1"]);
      } finally {
        await context.close();
      }
    });

    it("retains analysis lists and completed conclusions and permits remaining claims after task deletion", async () => {
      const context = await fixture(mode);
      try {
        await seed(context);
        await seedDeletionAssociations(context);
        for (const caseId of ["failure", "ddt-1"]) {
          await context.execute(
            "INSERT INTO run_attempts (id, execution_run_id, runner_id, attempt_number, status, outcome, scheduling_score, created_at) VALUES (?, ?, 'runner-1', 1, 'failed', 'failed', 1, ?)",
            [`attempt-${caseId}`, `run-${caseId}`, timestamp],
          );
        }
        const scope = {
          projectId: DEFAULT_PROJECT_ID,
          projectVersionId: "version-1",
          batchId: "batch-1",
        };
        expect(
          await context.analysis.startBatch({
            ...scope,
            startedBy: "user-1",
            startedAt: timestamp,
          }),
        ).toMatchObject({ created: true });
        const claimant = {
          ...scope,
          claimantId: "user-1",
          claimantUsername: "user-1",
          claimantDisplayName: "User",
          claimedAt: timestamp,
        };
        const completion = {
          projectId: DEFAULT_PROJECT_ID,
          claimantId: "user-1",
          category: "code_issue_filed" as const,
          issueDescription: "Retained conclusion",
          ticketReference: "BUG-1",
          completedAt: timestamp,
          rerunProofs: new Map<string, { attemptId: string; url: string }>(),
        };
        await context.analysis.claim({
          ...claimant,
          executionRunIds: ["run-failure"],
          claims: [{ id: "analysis-1", executionRunId: "run-failure" }],
        });
        await context.analysis.complete({ ...completion, analysisIds: ["analysis-1"] });
        const candidateQuery = {
          ...scope,
          sort: "class_path" as const,
          direction: "asc" as const,
          limit: 10,
        };
        const candidates = await context.analysis.listCandidates(candidateQuery);
        const batches = await context.analysis.listBatches({ ...scope, limit: 10 });
        const conclusion = await context.analysis.getClaim("analysis-1", DEFAULT_PROJECT_ID);
        const batch = await context.analysis.getBatch(scope);
        await context.suites.deleteSuite({ suiteId: "suite-1", expectedRevision: 2 });
        expect(await context.analysis.listCandidates(candidateQuery)).toEqual(candidates);
        expect(await context.analysis.listBatches({ ...scope, limit: 10 })).toEqual(batches);
        expect(await context.analysis.getBatch(scope)).toEqual(batch);
        expect(await context.analysis.getClaim("analysis-1", DEFAULT_PROJECT_ID)).toEqual(
          conclusion,
        );
        expect(
          await context.analysis.claim({
            ...claimant,
            executionRunIds: ["run-ddt-1"],
            claims: [{ id: "analysis-2", executionRunId: "run-ddt-1" }],
          }),
        ).toMatchObject({ unavailableExecutionRunIds: [], claims: [{ id: "analysis-2" }] });
        await context.analysis.complete({ ...completion, analysisIds: ["analysis-2"] });
        expect(await context.analysis.getClaim("analysis-2", DEFAULT_PROJECT_ID)).toMatchObject({
          status: "completed",
          issueDescription: "Retained conclusion",
        });
      } finally {
        await context.close();
      }
    });

    it("rejects stale deletion and rolls back every association when schedule cleanup fails", async () => {
      const context = await fixture(mode);
      try {
        await seed(context);
        await seedDeletionAssociations(context);
        const tables = [
          "case_suites",
          "case_suite_items",
          "case_suite_ddt_items",
          "case_suite_pins",
          "case_suite_round_recovery_credentials",
          "case_suite_webhook_bindings",
          "case_suite_schedules",
          "schedule_trigger_claims",
        ];
        const before = await Promise.all(
          tables.map((table) => context.rows(`SELECT * FROM ${table} ORDER BY 1`)),
        );
        await expect(
          context.suites.deleteSuite({ suiteId: "suite-1", expectedRevision: 1 }),
        ).rejects.toMatchObject({ code: "CASE_SUITE_REVISION_CONFLICT" });
        if (mode === "sqlite") {
          await context.execute(`CREATE TRIGGER reject_schedule_cleanup BEFORE DELETE ON case_suite_schedules
            BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END`);
        } else {
          await context.execute(`CREATE FUNCTION reject_schedule_cleanup() RETURNS trigger LANGUAGE plpgsql
            AS $$ BEGIN RAISE EXCEPTION 'cleanup failed'; END $$`);
          await context.execute(`CREATE TRIGGER reject_schedule_cleanup BEFORE DELETE ON case_suite_schedules
            FOR EACH ROW EXECUTE FUNCTION reject_schedule_cleanup()`);
        }
        await expect(
          context.suites.deleteSuite({ suiteId: "suite-1", expectedRevision: 2 }),
        ).rejects.toThrow();
        for (const [index, table] of tables.entries()) {
          expect(await context.rows(`SELECT * FROM ${table} ORDER BY 1`), table).toEqual(
            before[index],
          );
        }
      } finally {
        await context.close();
      }
    });

    it("revalidates task creation in the batch transaction and permits reruns from preserved history", async () => {
      const context = await fixture(mode);
      try {
        await seed(context);
        const record = {
          id: "guarded-batch",
          projectId: DEFAULT_PROJECT_ID,
          suiteId: "suite-1",
          suiteName: "Original",
          suiteVersion: 2,
          retryLimit: 0,
          environmentVariables: [],
          runnerIds: ["runner-1"],
          runs: [
            {
              id: "guarded-run",
              caseDefinitionId: "failure",
              caseVersion: 1,
              displayName: "Failure",
              className: "example.failure",
            },
          ],
          createdAt: timestamp,
        };
        await expect(
          context.batches.create({ ...record, expectedSuiteRevision: 1 }),
        ).rejects.toMatchObject({ code: "CASE_SUITE_REVISION_CONFLICT" });
        const started = await context.batches.create({ ...record, expectedSuiteRevision: 2 });
        await context.suites.deleteSuite({ suiteId: "suite-1", expectedRevision: 2 });
        expect(await context.batches.getSummary(started.id)).toEqual(started);
        await expect(
          context.batches.create({ ...record, id: "deleted-task-batch", expectedSuiteRevision: 2 }),
        ).rejects.toMatchObject({ code: "CASE_SUITE_NOT_FOUND" });
        expect(await context.batches.getSummary("deleted-task-batch")).toBeNull();
        expect(
          await context.batches.create({
            ...record,
            id: "historical-rerun",
            kind: "case_log_rerun",
            parentBatchId: "batch-1",
            sourceExecutionRunId: "run-recovered",
            runs: [{ ...record.runs[0]!, id: "historical-rerun-run" }],
          }),
        ).toMatchObject({ id: "historical-rerun", kind: "case_log_rerun", suiteId: "suite-1" });
      } finally {
        await context.close();
      }
    });

    it("allocates distinct automatic names for simultaneous copies and preserves custom names", async () => {
      const context = await fixture(mode);
      try {
        const { service } = await seed(context);
        await context.suites.updateSuite({
          suiteId: "suite-1",
          name: "Renamed after execution",
          expectedRevision: 2,
          versionId: "suite-snapshot-3",
          changeReason: "Rename",
          updatedAt: timestamp,
        });
        expect(await service.suggestFinalFailureName("batch-1")).toEqual({
          name: "Original Rerun-20261006",
        });
        const copies = await Promise.all(
          Array.from({ length: 4 }, () => service.createFromFinalFailures("batch-1", {})),
        );
        expect(copies.map((suite) => suite.name).sort()).toEqual([
          "Original Rerun-20261006",
          "Original Rerun-2026100601",
          "Original Rerun-2026100602",
          "Original Rerun-2026100603",
        ]);
        expect(
          copies.every((suite) => suite.caseCount === 3 && suite.policy.concurrency === 17),
        ).toBe(true);
        expect(await service.suggestFinalFailureName("batch-1")).toEqual({
          name: "Original Rerun-2026100604",
        });
        expect(
          (await service.createFromFinalFailures("batch-1", { name: " 自定义名称 " })).name,
        ).toBe("自定义名称");
      } finally {
        await context.close();
      }
    });

    it("checks archived tasks and every bounded name page within the source project version", async () => {
      const context = await fixture(mode);
      try {
        const { service, policy } = await seed(context);
        for (let offset = 0; offset <= 500; offset += 100) {
          const names = Array.from({ length: Math.min(100, 501 - offset) }, (_, index) => {
            const sequence = offset + index;
            return [
              `occupied-${String(sequence).padStart(4, "0")}`,
              `Original Rerun-20261006${sequence ? String(sequence).padStart(2, "0") : ""}`,
              JSON.stringify(policy),
              timestamp,
              timestamp,
            ];
          });
          await context.execute(
            `INSERT INTO case_suites (id, name, policy_json, created_at, updated_at, version) VALUES ${names.map(() => "(?, ?, ?, ?, ?, 1)").join(", ")}`,
            names.flat(),
          );
        }
        await context.execute(
          "UPDATE case_suites SET status = 'archived' WHERE id = 'occupied-0000'",
        );
        await context.suites.copySuite({
          id: "other-version-suite",
          name: "Original Rerun-20261006999",
          policy: { ...policy, projectVersionId: "other-version" },
          items: [],
          versionId: "other-version-snapshot",
          createdAt: timestamp,
        });
        expect(await service.suggestFinalFailureName("batch-1")).toEqual({
          name: "Original Rerun-20261006501",
        });
        expect((await service.createFromFinalFailures("batch-1", {})).name).toBe(
          "Original Rerun-20261006501",
        );
      } finally {
        await context.close();
      }
    });

    it("creates a task from 100,000 failures through bounded cursor pages and SQL writes", async () => {
      const context = await fixture(mode);
      try {
        const { service } = await seed(context);
        await context.execute(
          `WITH RECURSIVE members(number) AS (
          SELECT 1 UNION ALL SELECT number + 1 FROM members WHERE number < 100000
        ) INSERT INTO case_definitions
          (id, project_version_id, test_stage_id, source_id, class_name, package_name,
           display_name, enabled, groups_json, current_version, created_at, updated_at)
          SELECT 'large-' || number, 'version-1', 'stage-1', 'source-1',
            'example.Large' || number, 'example', 'Large ' || number, TRUE, '[]', 1, ?, ?
          FROM members`,
          [timestamp, timestamp],
        );
        await context.execute(`INSERT INTO run_batches
          (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json,
           total_runs, project_id, policy_json, created_at, updated_at)
          SELECT 'large-batch', suite_id, suite_name, suite_version, 'succeeded', retry_limit,
            environment_json, 100000, project_id, policy_json, created_at, updated_at
          FROM run_batches WHERE id = 'batch-1'`);
        await context.execute(
          `INSERT INTO execution_runs
          (id, batch_id, case_definition_id, case_version, display_name, class_name,
           status, terminal_outcome, created_at, updated_at)
          SELECT 'large-run-' || id, 'large-batch', id, 1, display_name, class_name,
            'failed', 'failed', ?, ? FROM case_definitions WHERE id LIKE 'large-%'`,
          [timestamp, timestamp],
        );
        const suite = await service.createFromFinalFailures("large-batch", {
          name: "Large failure task",
        });
        expect(suite.caseCount).toBe(100_000);
        expect(
          (await context.suites.listMemberPage({ suiteId: suite.id, limit: 5 }))!.items,
        ).toHaveLength(5);
      } finally {
        await context.close();
      }
    }, 60_000);

    it("copies the immutable configuration and only final failures/timeouts across TestNG and DDT", async () => {
      const context = await fixture(mode);
      try {
        const { service } = await seed(context);
        expect(await context.suites.getFailureCopySource("batch-1", [])).toBeNull();
        expect(await context.suites.getFailureCopySource("batch-1", ["other-project"])).toBeNull();
        const page = await context.suites.listFinalFailureMemberPage({
          batchId: "batch-1",
          projectId: DEFAULT_PROJECT_ID,
          projectVersionId: "version-1",
          limit: 2,
        });
        expect(page).toHaveLength(2);
        const next = await context.suites.listFinalFailureMemberPage({
          batchId: "batch-1",
          projectId: DEFAULT_PROJECT_ID,
          projectVersionId: "version-1",
          limit: 2,
          afterRunId: page.at(-1)!.runId,
          afterCreatedAt: page.at(-1)!.createdAt,
        });
        expect([...page, ...next].map((member) => member.caseId).sort()).toEqual([
          "ddt-1",
          "failure",
          "timeout",
        ]);
        const suite = await service.createFromFinalFailures(
          "batch-1",
          { name: "Failure task" },
          undefined,
          [DEFAULT_PROJECT_ID],
        );
        expect(suite).toMatchObject({
          version: 1,
          revision: 1,
          caseCount: 3,
          description: "Original description",
          policy: {
            concurrency: 17,
            priority: 9,
            retryLimit: 2,
            artifactPatterns: ["reports/**"],
            adapter: { environmentAddresses: ["https://adapter.internal"] },
          },
        });
        const members = await context.suites.listMemberPage({ suiteId: suite.id, limit: 100 });
        expect(members!.items.map((item) => item.caseDefinition.id).sort()).toEqual([
          "failure",
          "timeout",
        ]);
        expect(members!.ddtItems.map((item) => item.ddtCase.id)).toEqual(["ddt-1"]);
        expect((await context.suites.getSummary("suite-1"))?.policy.concurrency).toBe(99);
      } finally {
        await context.close();
      }
    });

    it("rolls back if a DDT member is recycled between selection and persistence", async () => {
      const context = await fixture(mode);
      try {
        const { service } = await seed(context);
        const copySuite = context.suites.copySuite.bind(context.suites);
        context.suites.copySuite = async (record) => {
          await context.execute("DELETE FROM ddt_cases WHERE id = 'ddt-1'");
          return copySuite(record);
        };
        await expect(
          service.createFromFinalFailures("batch-1", { name: "Failure task" }),
        ).rejects.toMatchObject({ code: "CASE_SUITE_FAILURE_MEMBER_UNAVAILABLE" });
        expect(await context.suites.list(100)).toHaveLength(1);
      } finally {
        await context.close();
      }
    });
  });
}

function deletionSchedule() {
  return {
    id: "schedule-1",
    suiteId: "suite-1",
    projectId: DEFAULT_PROJECT_ID,
    cronExpression: "0 9 * * *",
    timeZone: "Asia/Shanghai",
    missedRunPolicy: "skip" as const,
    enabled: true,
    nextTriggerAt: timestamp,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function seedDeletionAssociations(context: Fixture): Promise<void> {
  const { execute, suites } = context;
  await execute(
    "INSERT INTO case_suite_items (id, suite_id, case_definition_id, added_at) VALUES ('item-1', 'suite-1', 'failure', ?)",
    [timestamp],
  );
  await execute(
    "INSERT INTO case_suite_ddt_items (id, suite_id, ddt_case_id, added_at) VALUES ('ddt-item-1', 'suite-1', 'ddt-1', ?)",
    [timestamp],
  );
  await execute(
    "INSERT INTO users (id, username, normalized_username, display_name, source, status, created_at, updated_at) VALUES ('user-1', 'user-1', 'user-1', 'User', 'local', 'active', ?, ?)",
    [timestamp, timestamp],
  );
  await suites.setPinned({
    userId: "user-1",
    suiteId: "suite-1",
    pinned: true,
    createdAt: timestamp,
  });
  await execute(
    "INSERT INTO case_suite_round_recovery_credentials (suite_id, rule_id, api_key_ciphertext, updated_at) VALUES ('suite-1', 'rule-1', 'test-ciphertext', ?)",
    [timestamp],
  );
  await execute(
    "INSERT INTO webhook_configurations (id, project_id, name, normalized_name, target_url, method, created_at, updated_at) VALUES ('webhook-1', ?, 'Webhook', 'webhook', 'https://internal.example', 'GET', ?, ?)",
    [DEFAULT_PROJECT_ID, timestamp, timestamp],
  );
  await execute(
    "INSERT INTO case_suite_webhook_bindings (suite_id, webhook_id, created_at) VALUES ('suite-1', 'webhook-1', ?)",
    [timestamp],
  );
  await context.operations.upsertSchedule(deletionSchedule());
  await execute(
    "INSERT INTO schedule_trigger_claims (schedule_id, scheduled_for, claim_id, lease_expires_at, claimed_at) VALUES ('schedule-1', ?, 'claim-1', ?, ?)",
    [timestamp, timestamp, timestamp],
  );
  await execute(
    "INSERT INTO run_batches (id, suite_id, suite_name, suite_version, status, retry_limit, environment_json, total_runs, created_at, updated_at) VALUES ('active-batch', 'suite-1', 'Original', 2, 'running', 0, '[]', 1, ?, ?)",
    [timestamp, timestamp],
  );
  await execute(
    "INSERT INTO run_batch_round_recoveries (batch_id, rule_id, after_round, next_round, jenkins_job_url, api_key_ciphertext, wait_minutes, available_at, created_at, updated_at) VALUES ('active-batch', 'rule-1', 1, 2, 'https://jenkins.internal/job/reset/', 'in-flight-test-ciphertext', 1, ?, ?, ?)",
    [timestamp, timestamp, timestamp],
  );
  await execute(
    "INSERT INTO run_batch_status_events (id, batch_id, to_status, batch_version, reason, recorded_at) VALUES ('event-1', 'batch-1', 'succeeded', 1, 'Completed', ?)",
    [timestamp],
  );
  await execute(
    "INSERT INTO attempt_log_watermarks (attempt_id, stream, acknowledged_sequence, updated_at) VALUES ('attempt-1', 'stdout', 5, ?)",
    [timestamp],
  );
  await execute(
    "INSERT INTO attempt_artifacts (id, attempt_id, relative_path, object_key, media_type, size_bytes, sha256, status, created_at, updated_at) VALUES ('artifact-1', 'attempt-1', 'reports/result.xml', 'artifacts/result.xml', 'application/xml', 1, ?, 'uploaded', ?, ?)",
    ["b".repeat(64), timestamp, timestamp],
  );
  await execute(
    "INSERT INTO attempt_log_shares (id, token_hash, attempt_id, batch_id, created_by, created_at, expires_at) VALUES ('share-1', ?, 'attempt-1', 'batch-1', 'user-1', ?, '9999-12-31T23:59:59.999Z')",
    ["c".repeat(64), timestamp],
  );
  await execute(
    "INSERT INTO analytics_facts (attempt_id, project_id, batch_id, run_id, suite_id, case_definition_id, case_version, runner_id, outcome, completed_at) VALUES ('attempt-1', ?, 'batch-1', 'run-recovered', 'suite-1', 'recovered', 1, 'runner-1', 'failed', ?)",
    [DEFAULT_PROJECT_ID, timestamp],
  );
}
