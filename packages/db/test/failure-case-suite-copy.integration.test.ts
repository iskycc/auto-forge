import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  CaseSuiteService,
  type CaseCatalogRepository,
  type CaseSuiteRepository,
  type ProjectStructureRepository,
} from "@autoforge/application";
import { DEFAULT_PROJECT_ID, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";

import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";

const timestamp = "2026-10-06T00:00:00.000Z";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;

type Fixture = {
  suites: CaseSuiteRepository;
  execute: (statement: string, parameters?: Array<string | number>) => Promise<void>;
  close: () => Promise<void>;
};

async function fixture(mode: "sqlite" | "postgres"): Promise<Fixture> {
  if (mode === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-failure-copy-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    return {
      suites: new SqliteCaseSuiteRepository(handle),
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
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    poolMax: 2,
  });
  await handle.ready;
  return {
    suites: new PostgresCaseSuiteRepository(handle),
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
