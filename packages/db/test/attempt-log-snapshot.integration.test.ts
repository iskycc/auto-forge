import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RunBatchRepository } from "@autoforge/application";

import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const timestamp = "2026-10-06T00:00:00.000Z";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;

type SnapshotFixture = {
  batches: RunBatchRepository;
  statements(): string[];
  sqliteQueryPlan?(statement: string, parameters: Array<string | number>): string[];
  execute(statement: string, parameters?: Array<string | number>): Promise<void>;
  close(): Promise<void>;
};

async function createFixture(mode: "sqlite" | "postgres"): Promise<SnapshotFixture> {
  if (mode === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-log-snapshot-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    const queries = vi.spyOn(handle.client, "prepare");
    return {
      batches: new SqliteRunBatchRepository(handle),
      statements: () => queries.mock.calls.map(([statement]) => statement),
      sqliteQueryPlan: (statement, parameters) =>
        (
          handle.client.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...parameters) as Array<{
            detail: string;
          }>
        ).map((row) => row.detail),
      execute: async (statement, parameters = []) => {
        handle.client.prepare(statement).run(...parameters);
      },
      close: async () => {
        queries.mockRestore();
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const schema = `log_snapshot_${randomUUID().replaceAll("-", "")}`;
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
  const queries = vi.spyOn(handle.pool, "query");
  return {
    batches: new PostgresRunBatchRepository(handle),
    statements: () =>
      queries.mock.calls.map(([statement]) =>
        typeof statement === "string" ? statement : (statement as { text: string }).text,
      ),
    execute: async (statement, parameters = []) => {
      let index = 0;
      await handle.pool.query(
        statement.replaceAll("?", () => `$${++index}`),
        parameters,
      );
    },
    close: async () => {
      queries.mockRestore();
      await handle.close();
      await administration.query(`DROP SCHEMA ${schema} CASCADE`);
      await administration.end();
    },
  };
}

async function seedSnapshot(fixture: SnapshotFixture): Promise<void> {
  const runtime = JSON.stringify({
    suiteName: "Suite",
    testName: "Test",
    environmentAddresses: ["https://adapter.internal"],
    environmentAddressByRunId: Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`run-${index}`, "https://adapter.internal"]),
    ),
    fallbackEnvironmentAddress: "",
    jarBundle: {
      id: "bundle",
      sourceType: "upload",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      archiveFormat: "zip",
      createdAt: timestamp,
    },
  });
  await fixture.execute(
    `INSERT INTO run_batches
     (id, sequence_number, suite_id, suite_name, suite_version, status, retry_limit,
      total_runs, environment_json, adapter_runtime_json, created_at, updated_at)
     VALUES ('batch', 7, 'suite', 'Active task', 1, 'running', 3, 10000, '[]', ?, ?, ?)`,
    [runtime, timestamp, timestamp],
  );
  for (const [runId, caseType, displayName] of [
    ["run-testng", "testng", "Checkout"],
    ["run-ddt", "ddt", "DDT001"],
  ]) {
    await fixture.execute(
      `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        case_type, status, attempt_count, created_at, updated_at)
       VALUES (?, 'batch', ?, 1, ?, 'example.Checkout', ?, 'succeeded', 1, ?, ?)`,
      [runId!, runId!, displayName!, caseType!, timestamp, timestamp],
    );
  }
  await fixture.execute(
    `INSERT INTO projects (id, name, slug, created_at, updated_at)
     VALUES ('project-ddt', 'DDT project', 'ddt-project', ?, ?)`,
    [timestamp, timestamp],
  );
  await fixture.execute(
    `INSERT INTO project_versions
     (id, project_id, name, normalized_name, created_at, updated_at)
     VALUES ('version-ddt', 'project-ddt', 'v1', 'v1', ?, ?)`,
    [timestamp, timestamp],
  );
  await fixture.execute(
    `INSERT INTO test_stages
     (id, project_id, project_version_id, name, normalized_name, position, created_at, updated_at)
     VALUES ('stage-ddt', 'project-ddt', 'version-ddt', 'Regression', 'regression', 0, ?, ?)`,
    [timestamp, timestamp],
  );
  await fixture.execute(
    `INSERT INTO ddt_cases
     (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized,
      sr_num, sr_num_normalized, case_kind, data_json, created_at, updated_at)
     VALUES ('run-ddt', 'project-ddt', 'version-ddt', 'stage-ddt', 'DDT001', 'ddt001',
             'SR1', 'sr1', 'standard', '{}', ?, ?)`,
    [timestamp, timestamp],
  );
  await fixture.execute(
    `WITH RECURSIVE members(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM members WHERE n < 9998
     )
     INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        status, created_at, updated_at)
     SELECT 'live-' || CAST(n AS TEXT), 'batch', 'live-' || CAST(n AS TEXT), 1,
            'Live case ' || CAST(n AS TEXT), 'example.Live', 'running', ?, ?
     FROM members`,
    [timestamp, timestamp],
  );
}

for (const mode of ["sqlite", "postgres"] as const) {
  describe.skipIf(mode === "postgres" && !postgresUrl)(`${mode} attempt log snapshot`, () => {
    it("separates task and single executions before cursor pagination and reads only page entries", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        for (const [id, kind, suiteId] of [
          ["manual-1", "standard", "single:case"],
          ["manual-2", "standard", "single:case"],
          ["hidden", "case_log_rerun", "suite"],
        ]) {
          await fixture.execute(
            `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,batch_kind,environment_json,created_at,updated_at) VALUES (?,?,?,1,'queued',0,1,?,'[]',?,?)`,
            [id!, suiteId!, id!, kind!, timestamp, timestamp],
          );
          await fixture.execute(
            `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,created_at,updated_at) VALUES (?,?,?,1,'中文用例','example.Case','queued',?,?)`,
            [id! + "-run", id!, "case", timestamp, timestamp],
          );
        }
        const first = await fixture.batches.listMetadataPage({ executionKind: "single", limit: 1 });
        expect(first.items.map((batch) => batch.id)).toEqual(["manual-2"]);
        expect(first.nextCursor).toBeDefined();
        const second = await fixture.batches.listMetadataPage({
          executionKind: "single",
          limit: 1,
          cursor: first.nextCursor!,
        });
        expect(second.items.map((batch) => batch.id)).toEqual(["manual-1"]);
        expect(second.nextCursor).toBeUndefined();
        const tasks = await fixture.batches.listMetadataPage({ executionKind: "task", limit: 1 });
        expect(tasks.items.map((batch) => batch.id)).toEqual(["batch"]);
        const start = fixture.statements().length;
        expect(
          await fixture.batches.readSingleCaseExecutionEntries(["manual-1", "batch", "hidden"]),
        ).toEqual([
          expect.objectContaining({
            batchId: "manual-1",
            displayName: "中文用例",
            caseType: "testng",
            attempt: null,
          }),
        ]);
        const queries = fixture.statements().slice(start);
        expect(queries).toHaveLength(1);
        expect(queries[0]).not.toContain("testng_result_json");
        expect(queries[0]).not.toContain("adapter_runtime_json");
        expect(await fixture.batches.readSingleCaseExecutionEntries([])).toEqual([]);
      } finally {
        await fixture.close();
      }
    });

    it("reads a manual log target without full details, reports or unrelated attempt scans", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        await fixture.execute(
          `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,batch_kind,parent_batch_id,source_execution_run_id,environment_json,created_at,updated_at) VALUES ('manual','suite','Manual',1,'queued',0,1,'case_log_rerun','batch','run-ddt','[]',?,?)`,
          [timestamp, timestamp],
        );
        const fullDetails = vi.spyOn(fixture.batches, "get");
        const counters = vi.spyOn(fixture.batches, "getSummary");
        expect(await fixture.batches.getCaseLogRerunLogTarget("missing")).toBeNull();
        expect(await fixture.batches.getCaseLogRerunLogTarget("batch")).toBeNull();
        expect(await fixture.batches.getCaseLogRerunLogTarget("manual")).toMatchObject({
          batchStatus: "queued",
          attempt: null,
        });
        await fixture.execute(
          `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES ('manual-run','manual','case',1,'订单支付_中文001','example.Checkout','running',2,?,?)`,
          [timestamp, timestamp],
        );
        await fixture.execute(
          `INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES ('runner','hash','runner','linux','amd64','1.19.22',1,'[]',4,0,?,?,?)`,
          [timestamp, timestamp, timestamp],
        );
        for (const [id, number] of [
          ["manual-a", 1],
          ["manual-z", 2],
        ] as const) {
          await fixture.execute(
            `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,created_at) VALUES (?,'manual-run','runner',?,'running',1,?)`,
            [id, number, timestamp],
          );
        }
        const before = fixture.statements().length;
        expect(await fixture.batches.getCaseLogRerunLogTarget("manual")).toMatchObject({
          batchStatus: "queued",
          attempt: { id: "manual-z", status: "running" },
        });
        const queries = fixture.statements().slice(before);
        expect(queries).toHaveLength(1);
        expect(queries[0]!.toLowerCase()).not.toMatch(/exists|json|select\s+\*/u);
        expect(queries[0]!.toLowerCase()).toContain("join");
        if (fixture.sqliteQueryPlan) {
          const plan = fixture.sqliteQueryPlan(queries[0]!, ["manual", "case_log_rerun", 1]);
          expect(plan.join("\n")).not.toMatch(/SCAN run_attempts/u);
          expect(plan.join("\n")).toMatch(/SEARCH run_attempts USING/u);
        }
        expect(fullDetails).not.toHaveBeenCalled();
        expect(counters).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    });

    it("prepares a cold DDT rerun without scanning unrelated assignments or attempts", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        for (const [runnerId, attemptId, runId, address, createdAt] of [
          ["runner", "source-attempt", "run-ddt", "10.0.0.22", timestamp],
          [
            "unrelated-runner",
            "unrelated-attempt",
            "run-testng",
            "10.0.0.99",
            "2026-10-06T00:00:01.000Z",
          ],
        ]) {
          await fixture.execute(
            `INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES (?,?,'runner','linux','amd64','1.20.0',1,'[]',4,0,?,?,?)`,
            [runnerId!, runnerId!, createdAt!, createdAt!, createdAt!],
          );
          await fixture.execute(
            `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,outcome,scheduling_score,created_at) VALUES (?,?,?,1,'failed','failed',1,?)`,
            [attemptId!, runId!, runnerId!, createdAt!],
          );
          await fixture.execute(
            `INSERT INTO assignments(id,attempt_id,execution_run_id,batch_id,runner_id,status,execution_spec_json,available_at,claim_deadline_at,created_at,updated_at) VALUES (?,?,?,'batch',?,'completed',?,?,?,?,?)`,
            [
              `${attemptId}-assignment`,
              attemptId!,
              runId!,
              runnerId!,
              JSON.stringify({ adapter: { environmentAddress: address } }),
              createdAt!,
              createdAt!,
              createdAt!,
              createdAt!,
            ],
          );
        }
        const before = fixture.statements().length;
        const snapshot = await fixture.batches.getRerunSnapshot("batch", {
          executionRunId: "run-ddt",
        });
        expect(snapshot?.sourceAdapterEnvironmentAddress).toBe("10.0.0.22");
        await fixture.execute(
          `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,batch_kind,parent_batch_id,source_execution_run_id,environment_json,created_at,updated_at) VALUES ('manual','suite','Manual',1,'queued',0,1,'case_log_rerun','batch','run-ddt','[]',?,?)`,
          [timestamp, timestamp],
        );
        await fixture.execute(
          `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,case_type,status,created_at,updated_at) VALUES ('manual-run','manual','ddt',1,'订单支付_中文001','example.Checkout','ddt','queued',?,?)`,
          [timestamp, timestamp],
        );
        await fixture.execute(
          "UPDATE run_batches SET adapter_runtime_json = ? WHERE id = 'manual'",
          [
            JSON.stringify({
              suiteName: "Manual",
              testName: "Override",
              environmentAddresses: ["10.0.0.88"],
              environmentAddressByRunId: { "manual-run": "10.0.0.88" },
            }),
          ],
        );
        await expect(
          fixture.batches.getRerunSnapshot("batch", { executionRunId: "run-ddt" }),
        ).resolves.toMatchObject({ sourceAdapterEnvironmentAddress: "10.0.0.22" });
        const scheduling = await fixture.batches.getSchedulingSnapshot("manual", timestamp);
        expect(scheduling?.runnerHistoryByRun).toEqual({ "manual-run": ["runner"] });
        if (fixture.sqliteQueryPlan) {
          const queries = fixture.statements().slice(before);
          const historyReads = queries.filter((statement) =>
            /SELECT (?:assignment\.execution_spec_json|attempt\.runner_id) AS/u.test(statement),
          );
          expect(historyReads).toHaveLength(3);
          for (const statement of historyReads) {
            const plan = fixture.sqliteQueryPlan(statement, [
              "batch",
              "run-ddt",
              ...(statement.includes("UNION ALL") ? ["batch", "run-ddt"] : []),
            ]);
            expect(plan.join("\n")).not.toMatch(/SCAN (?:assignment|attempt)\b/u);
          }
        }
      } finally {
        await fixture.close();
      }
    });

    it("reads TestNG/DDT execution facts without batch counters or rerun preparation", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        const counters = vi.spyOn(fixture.batches, "getSummary");
        const rerun = vi.spyOn(fixture.batches, "getRerunSnapshot");
        for (const [runId, caseType, displayName] of [
          ["run-testng", "testng", "Checkout"],
          ["run-ddt", "ddt", "DDT001"],
        ]) {
          expect(await fixture.batches.getAttemptLogSnapshot("batch", runId!)).toEqual({
            batchId: "batch",
            batchSequenceNumber: 7,
            executionRunId: runId,
            caseDefinitionId: runId,
            ddtCaseId: caseType === "ddt" ? "DDT001" : null,
            ddtProjectId: caseType === "ddt" ? "project-ddt" : null,
            ddtProjectVersionId: caseType === "ddt" ? "version-ddt" : null,
            ddtTestStageId: caseType === "ddt" ? "stage-ddt" : null,
            displayName,
            className: "example.Checkout",
            caseType,
            dependencyUpdatedAt: timestamp,
          });
        }
        expect(await fixture.batches.getMetadata("batch")).toMatchObject({ status: "running" });
        expect(counters).not.toHaveBeenCalled();
        expect(rerun).not.toHaveBeenCalled();
        if (fixture.sqliteQueryPlan) {
          const statement = fixture.statements().find((sql) => sql.includes("AS ddtCaseId"))!;
          const plan = fixture.sqliteQueryPlan(statement, ["run-ddt", "batch"]);
          expect(plan.join("\n")).not.toMatch(/SCAN (?:run|ddt)\b/u);
        }
      } finally {
        await fixture.close();
      }
    });

    it("retains historical execution facts after the DDT record is removed", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        await fixture.execute("DELETE FROM ddt_cases WHERE id = 'run-ddt'");
        expect(await fixture.batches.getAttemptLogSnapshot("batch", "run-ddt")).toMatchObject({
          caseType: "ddt",
          caseDefinitionId: "run-ddt",
          displayName: "DDT001",
          ddtCaseId: null,
          ddtProjectId: null,
          ddtProjectVersionId: null,
          ddtTestStageId: null,
        });
      } finally {
        await fixture.close();
      }
    });

    it("reads only log history metadata without TestNG report bodies", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        await fixture.execute(
          `INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES ('runner','hash','runner','linux','amd64','1.19.9',1,'[]',4,0,?,?,?)`,
          [timestamp, timestamp, timestamp],
        );
        await fixture.execute(
          `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,outcome,result_code,scheduling_score,created_at) VALUES ('attempt','run-testng','runner',1,1,'succeeded','succeeded','TESTNG_SUCCEEDED',1,?)`,
          [timestamp],
        );
        const before = fixture.statements().length;
        expect(await fixture.batches.listAttemptsForExecutionRun!("run-testng")).toEqual([
          expect.objectContaining({
            id: "attempt",
            executionRunId: "run-testng",
            status: "succeeded",
            resultCode: "TESTNG_SUCCEEDED",
          }),
        ]);
        const reads = fixture.statements().slice(before);
        expect(reads).toHaveLength(1);
        expect(reads[0]).not.toContain("testng_result_json");
        await fixture.execute(
          `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,batch_kind,parent_batch_id,source_execution_run_id,environment_json,requested_by_username,requested_by_source,created_at,updated_at) VALUES ('rerun','suite','Rerun',1,'succeeded',0,1,'case_log_rerun','batch','run-testng','[]','analyst','local',?,?)`,
          [timestamp, timestamp],
        );
        await fixture.execute(
          `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES ('rerun-run','rerun','rerun-case',1,'Checkout','example.Checkout','succeeded',1,?,?)`,
          [timestamp, timestamp],
        );
        await fixture.execute(
          `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,outcome,result_code,scheduling_score,created_at) VALUES ('rerun-attempt','rerun-run','runner',1,'succeeded','succeeded','TESTNG_SUCCEEDED',1,?)`,
          [timestamp],
        );
        const fullDetails = vi.spyOn(fixture.batches, "get");
        const history = await fixture.batches.listCaseLogRerunBatches("batch", "run-testng", 500);
        expect(history).toEqual([
          {
            id: "rerun",
            requestedBy: { username: "analyst", source: "local" },
            attempts: [expect.objectContaining({ id: "rerun-attempt", status: "succeeded" })],
          },
        ]);
        expect(fullDetails).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    });

    it("locates a large-batch rerun through metadata and reads only the selected case snapshot", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        const fullDetails = vi.spyOn(fixture.batches, "get");
        const counters = vi
          .spyOn(fixture.batches, "getSummary")
          .mockRejectedValue(new Error("Single-case reruns must not aggregate the source batch"));
        expect(await fixture.batches.getMetadata("batch")).toMatchObject({
          id: "batch",
          kind: "standard",
          status: "running",
          totalRuns: 10_000,
        });
        const snapshot = await fixture.batches.getRerunSnapshot("batch", {
          executionRunId: "run-testng",
        });
        expect(counters).not.toHaveBeenCalled();
        expect(snapshot?.runs).toEqual([
          expect.objectContaining({
            id: "run-testng",
            displayName: "Checkout",
            className: "example.Checkout",
          }),
        ]);
        await fixture.execute(
          `INSERT INTO run_batches
           (id, suite_id, suite_name, suite_version, status, retry_limit, total_runs,
            batch_kind, parent_batch_id, source_execution_run_id, environment_json,
            created_at, updated_at)
           VALUES ('manual-rerun', 'suite', 'Manual rerun', 1, 'succeeded', 0, 1,
                   'case_log_rerun', 'batch', 'run-testng', '[]', ?, ?)`,
          [timestamp, timestamp],
        );
        expect(await fixture.batches.getMetadata("manual-rerun")).toMatchObject({
          id: "manual-rerun",
          kind: "case_log_rerun",
          parentBatchId: "batch",
          sourceExecutionRunId: "run-testng",
          totalRuns: 1,
        });
        expect(fullDetails).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    });

    it("rejects a case from another batch and preserves missing historical dependency dates", async () => {
      const fixture = await createFixture(mode);
      try {
        await seedSnapshot(fixture);
        expect(await fixture.batches.getAttemptLogSnapshot("other-batch", "run-testng")).toBeNull();
        expect(await fixture.batches.getAttemptLogSnapshot("batch", "missing-run")).toBeNull();
        await fixture.execute(
          "UPDATE run_batches SET adapter_runtime_json = NULL WHERE id = 'batch'",
        );
        expect(await fixture.batches.getAttemptLogSnapshot("batch", "run-testng")).toMatchObject({
          dependencyUpdatedAt: null,
        });
      } finally {
        await fixture.close();
      }
    });
  });
}
