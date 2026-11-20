import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { describe, it, expect, vi } from "vitest";
import { RunBatchExportService, buildRunBatchExportRows } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { DEFAULT_PROJECT_ID, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";
import { SqliteRunBatchRepository } from "../src/sqlite-run-batch";
import { PostgresRunBatchRepository } from "../src/postgres-run-batch";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !postgresUrl)(`${dialect} paged result exports`, () => {
    it("upgrades the previous task schema without altering membership and rolls back failed DDL", async () => {
      const migrations = resolve(
        "packages/db/drizzle",
        dialect === "sqlite" ? "sqlite" : "postgresql",
      );
      const next =
        dialect === "sqlite" ? "0103_case_suite_membership.sql" : "0102_case_suite_membership.sql";
      const previous = await mkdtemp(join(tmpdir(), "suite-membership-upgrade-"));
      try {
        for (const file of await readdir(migrations))
          if (file.endsWith(".sql") && file < next)
            await copyFile(join(migrations, file), join(previous, file));
        const f = await exportDatabase(dialect, previous);
        try {
          const now = "2026-11-17T00:00:00.000Z";
          const suite = await f.suites.create({
            id: "legacy-suite",
            name: "历史任务",
            policy: defaultCaseSuiteExecutionPolicy,
            createdAt: now,
          });
          await f.execute(`INSERT INTO project_versions(id,project_id,name,normalized_name,created_at,updated_at)
            VALUES ('legacy-version','${DEFAULT_PROJECT_ID}','legacy','legacy','${now}','${now}')`);
          await f.execute(`INSERT INTO test_stages(id,project_id,project_version_id,name,normalized_name,position,created_at,updated_at)
            VALUES ('legacy-stage','${DEFAULT_PROJECT_ID}','legacy-version','legacy','legacy',0,'${now}','${now}')`);
          await f.execute(`INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at)
            VALUES ('legacy-case','${DEFAULT_PROJECT_ID}','legacy-version','legacy-stage','历史用例','历史用例','SR','sr','standard','{}','${now}','${now}')`);
          await f.execute(`INSERT INTO case_suite_ddt_items(id,suite_id,ddt_case_id,added_at)
            VALUES ('legacy-member','${suite.id}','legacy-case','${now}')`);
          const migration = await readFile(join(migrations, next), "utf8");
          await f.execute("BEGIN");
          await f.execute(migration);
          await expect(f.execute("INSERT INTO missing_upgrade_table VALUES(1)")).rejects.toThrow();
          await f.execute("ROLLBACK");
          await expect(f.suites.listMemberChanges(suite.id, undefined, 10)).rejects.toThrow();
          await f.execute("BEGIN");
          await f.execute(migration);
          await f.execute("COMMIT");
          expect(await f.suites.getSummary(suite.id)).toMatchObject({
            id: suite.id,
            name: suite.name,
            caseCount: 1,
          });
          expect(
            (await f.suites.listMarkerMembers(suite.id, "ddt", undefined, 10, "")).items,
          ).toEqual([
            { kind: "ddt", memberId: "legacy-member", caseLabel: "历史用例", markers: [] },
          ]);
          expect((await f.suites.listMemberChanges(suite.id, undefined, 10)).items).toEqual([]);
        } finally {
          await f.close();
        }
      } finally {
        await rm(previous, { recursive: true, force: true });
      }
    }, 30_000);

    it("audits membership changes and reads the current task markers for existing failed runs", async () => {
      const f = await exportDatabase(dialect);
      const now = "2026-11-18T00:00:00.000Z";
      const user = "member-operator";
      try {
        await f.execute(`INSERT INTO users(id,username,normalized_username,display_name,source,status,created_at,updated_at)
          VALUES ('${user}','audit.operator','audit.operator','Audit Operator','local','active','${now}','${now}')`);
        await f.execute(`INSERT INTO project_versions(id,project_id,name,normalized_name,created_at,updated_at)
          VALUES ('version','${DEFAULT_PROJECT_ID}','version','version','${now}','${now}')`);
        await f.execute(`INSERT INTO test_stages(id,project_id,project_version_id,name,normalized_name,position,created_at,updated_at)
          VALUES ('stage','${DEFAULT_PROJECT_ID}','version','stage','stage',0,'${now}','${now}')`);
        await f.execute(`INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES
          ('case-ddt','${DEFAULT_PROJECT_ID}','version','stage','钱包-支付','钱包-支付','SR','sr','standard','{}','${now}','${now}'),
          ('case-passed','${DEFAULT_PROJECT_ID}','version','stage','钱包-通过','钱包-通过','SR','sr','standard','{}','${now}','${now}')`);
        const suite = await f.suites.create({
          id: "marker-suite",
          name: "钱包验证",
          policy: defaultCaseSuiteExecutionPolicy,
          createdAt: now,
        });
        const other = await f.suites.create({
          id: "other-suite",
          name: "另一任务",
          policy: defaultCaseSuiteExecutionPolicy,
          createdAt: now,
        });
        const mutation = { suiteId: suite.id, actorId: user, updatedAt: now };
        const items = [
          { id: "member-ddt", ddtCaseId: "case-ddt" },
          { id: "member-passed", ddtCaseId: "case-passed" },
        ];
        const populated = await f.suites.addDdtCases({
          ...mutation,
          versionId: "change-1",
          items,
          remark: "补充支付场景",
        });
        await f.suites.addDdtCases({ ...mutation, versionId: "change-2", items });
        await f.suites.addDdtCases({
          ...mutation,
          suiteId: other.id,
          versionId: "other-add",
          items: [{ id: "other-member", ddtCaseId: "case-ddt" }],
        });
        expect((await f.suites.listMemberChanges(suite.id, undefined, 10)).items).toEqual([
          {
            id: "change-1",
            kind: "ddt",
            operation: "add",
            count: 2,
            actorName: "audit.operator",
            remark: "补充支付场景",
            changedAt: now,
          },
        ]);
        const first = await f.suites.listMemberChangeItems(suite.id, "change-1", undefined, 1);
        expect(first.items).toEqual([{ caseId: "case-ddt", caseLabel: "钱包-支付" }]);
        expect(
          (await f.suites.listMemberChangeItems(suite.id, "change-1", first.nextCursor, 1)).items,
        ).toEqual([{ caseId: "case-passed", caseLabel: "钱包-通过" }]);
        expect(
          (await f.suites.listMemberChangeItems(other.id, "change-1", undefined, 10)).items,
        ).toEqual([]);
        const edit = { ...mutation, versionId: "markers-1", expectedRevision: populated.revision };
        const foreign = { kind: "ddt" as const, memberId: "other-member", markers: ["其他任务"] };
        await expect(
          f.suites.updateMemberMarkers({ ...edit, edits: [foreign] }),
        ).rejects.toMatchObject({ code: "CASE_SUITE_MARKER_MEMBER_MISMATCH" });
        const updated = await f.suites.updateMemberMarkers({
          ...edit,
          edits: [
            { kind: "ddt", memberId: "member-ddt", markers: ["", "支付域", "", "", "优先"] },
            { kind: "ddt", memberId: "member-passed", markers: ["仅通过用例"] },
          ],
        });
        await expect(
          f.suites.updateMemberMarkers({ ...edit, versionId: "stale", edits: [foreign] }),
        ).rejects.toMatchObject({ code: "CASE_SUITE_REVISION_CONFLICT" });
        expect(
          (await f.suites.listMarkerMembers(other.id, "ddt", undefined, 10, "")).items[0]?.markers,
        ).toEqual([]);
        expect(
          (await f.suites.listMarkerMembers(suite.id, "ddt", undefined, 10, "支付")).items[0]
            ?.markers,
        ).toEqual(["", "支付域", "", "", "优先"]);

        await f.batches.create({
          ...mutation,
          id: "marker-batch",
          suiteName: suite.name,
          suiteVersion: updated.version,
          expectedSuiteRevision: updated.revision,
          retryLimit: 0,
          environmentVariables: [],
          secretBindings: [],
          runnerIds: [],
          createdAt: now,
          runs: [
            {
              id: "run-ddt",
              caseDefinitionId: "case-ddt",
              caseVersion: 1,
              displayName: "钱包-支付",
              className: "example.PaymentTest",
              caseType: "ddt",
            },
            {
              id: "run-passed",
              caseDefinitionId: "case-passed",
              caseVersion: 1,
              displayName: "钱包-通过",
              className: "example.PaymentTest",
              caseType: "ddt",
            },
          ],
        });
        await f.execute(
          `INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES ('runner','hash','runner','linux','amd64','1.22.24',1,'[]',1,0,'${now}','${now}','${now}')`,
        );
        for (const [id, outcome, code] of [
          ["ddt", "failed", "TESTNG_ASSERTIONS_FAILED"],
          ["passed", "succeeded", "TESTNG_SUCCEEDED"],
        ])
          await f.execute(
            `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,outcome,result_code,scheduling_score,created_at) VALUES ('attempt-${id}','run-${id}','runner',1,'${outcome}','${outcome}','${code}',1,'${now}')`,
          );
        const refreshed = await f.suites.updateMemberMarkers({
          ...mutation,
          versionId: "markers-after-execution",
          expectedRevision: updated.revision,
          edits: [{ kind: "ddt", memberId: "member-ddt", markers: ["导出实时值", "", "复测"] }],
        });
        const exportService = new RunBatchExportService(f.batches);
        const query = { batchId: "marker-batch", scope: "final", outcomes: ["failed"] } as const;
        const report = await exportService.prepare(query, { includeMarkerColumns: true });
        expect(report.markerColumns).toEqual([0, 2]);
        const rows = [];
        for await (const page of report.pages) rows.push(...page);
        expect(rows.map((row) => row.markers)).toEqual([["导出实时值", "", "复测"]]);
        const cleared = await f.suites.updateMemberMarkers({
          ...mutation,
          versionId: "markers-clear",
          expectedRevision: refreshed.revision,
          edits: [{ kind: "ddt", memberId: "member-ddt", markers: [""] }],
        });
        expect(cleared.revision).toBeGreaterThan(refreshed.revision);
        await f.suites.removeDdtCases({
          ...mutation,
          versionId: "change-3",
          ddtCaseIds: ["case-ddt", "missing"],
          remark: "支付迁移",
        });
        const history = await f.suites.listMemberChanges(suite.id, undefined, 10);
        expect(
          history.items.map(({ operation, count, remark }) => ({ operation, count, remark })),
        ).toEqual([
          { operation: "remove", count: 1, remark: "支付迁移" },
          { operation: "add", count: 2, remark: "补充支付场景" },
        ]);
        const afterRemoval = await exportService.prepare(query, { includeMarkerColumns: true });
        expect(afterRemoval.markerColumns).toEqual([]);
        for await (const page of afterRemoval.pages) {
          expect(page).toMatchObject([{ executionRunId: "run-ddt" }]);
          expect(page[0]?.markers).toBeUndefined();
        }
        const removed = await f.suites.unlinkDdtScopePage({
          ...mutation,
          scope: {
            projectId: DEFAULT_PROJECT_ID,
            projectVersionId: "version",
            testStageId: "stage",
          },
          auditActorId: user,
          clearedBefore: now,
          requestId: "clear-ddt-for-suite",
          auditId: "scope-clear-audit",
          versionId: "scope-clear-event",
        });
        expect(removed).toBe(1);
        expect(
          (await f.suites.listMemberChanges(suite.id, undefined, 10)).items.find(
            (event) => event.id === "scope-clear-event",
          ),
        ).toMatchObject({ kind: "ddt", operation: "remove", count: 1, remark: "清空 DDT 范围" });
      } finally {
        await f.close();
      }
    });

    it("exports original DDT CaseName and SRID cells without filling standard cases or missing fields", async () => {
      const fixture = await exportDatabase(dialect);
      try {
        const now = "2026-10-21T00:00:00.000Z";
        await fixture.execute(
          `INSERT INTO projects(id,name,slug,created_at,updated_at) VALUES ('project','project','project','${now}','${now}')`,
        );
        await fixture.execute(
          `INSERT INTO project_versions(id,project_id,name,normalized_name,created_at,updated_at) VALUES ('version','project','version','version','${now}','${now}')`,
        );
        await fixture.execute(
          `INSERT INTO test_stages(id,project_id,project_version_id,name,normalized_name,position,created_at,updated_at) VALUES ('stage','project','version','stage','stage',0,'${now}','${now}')`,
        );
        await fixture.execute(
          `INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES ('runner','hash','runner','linux','amd64','1.20.1',1,'[]',1,0,'${now}','${now}','${now}')`,
        );
        await fixture.execute(
          `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,created_at,updated_at) VALUES ('mixed','suite','suite',1,'failed',0,5,'[]','${now}','${now}')`,
        );
        const definitions = [
          ["a", "testng", { CaseName: "must stay blank", SRID: "not a DDT run" }],
          [
            "b",
            "ddt",
            { CaseName: "  中文名称\n原文  ", SRID: "00123", unrelated: "x".repeat(262_144) },
          ],
          ["c", "ddt", { caseName: "wrong case", srNum: "do not substitute" }],
          ["d", "ddt", { CaseName: 0, SRID: false }],
          ["e", "ddt", null],
        ] as const;
        for (const [id, kind, cells] of definitions) {
          await fixture.execute(
            `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,case_type,status,attempt_count,created_at,updated_at) VALUES ('${id}','mixed','case-${id}',1,'${id}','example.Test','${kind}','failed',1,'${now}','${now}')`,
          );
          if (cells)
            await fixture.execute(
              `INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES ('case-${id}','project','version','stage','${id}','${id}','SR','sr','standard','${JSON.stringify(cells)}','${now}','${now}')`,
            );
          await fixture.execute(
            `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,outcome,result_code,scheduling_score,created_at) VALUES ('attempt-${id}','${id}','runner',1,'failed','failed','TESTNG_ASSERTIONS_FAILED',1,'${now}')`,
          );
        }
        const prepared = await new RunBatchExportService(fixture.batches).prepare({
          batchId: "mixed",
          scope: "final",
          outcomes: ["failed"],
        });
        expect(prepared).toMatchObject({ includesDdt: true });
        const rows = [];
        for await (const page of prepared.pages) rows.push(...page);
        expect(rows[0]).not.toHaveProperty("ddt");
        expect(rows.slice(1)).toMatchObject([
          { ddt: { caseName: "  中文名称\n原文  ", srId: "00123" } },
          { ddt: { caseName: null, srId: null } },
          { ddt: { caseName: 0, srId: false } },
          { ddt: { caseName: null, srId: null } },
        ]);
        // Column presence describes the entire batch, even when DDT rows are filtered out.
        expect(
          await new RunBatchExportService(fixture.batches).prepare({
            batchId: "mixed",
            scope: "final",
            outcomes: ["succeeded"],
          }),
        ).toMatchObject({ includesDdt: true });
      } finally {
        await fixture.close();
      }
    });
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

async function exportDatabase(dialect: "sqlite" | "postgres", migrationsFolder?: string) {
  const directory = await mkdtemp(join(tmpdir(), "run-export-pages-"));
  if (dialect === "sqlite") {
    const handle = createSqliteDatabase({
      databasePath: join(directory, "platform.sqlite"),
      migrationsFolder: migrationsFolder ?? resolve("packages/db/drizzle/sqlite"),
    });
    const queries = vi.spyOn(handle.client, "prepare");
    return {
      batches: new SqliteRunBatchRepository(handle),
      suites: new SqliteCaseSuiteRepository(handle),
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
    migrationsFolder: migrationsFolder ?? resolve("packages/db/drizzle/postgresql"),
    poolMax: 1,
  });
  await handle.ready;
  const queries = vi.spyOn(handle.pool, "query");
  return {
    batches: new PostgresRunBatchRepository(handle),
    suites: new PostgresCaseSuiteRepository(handle),
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
