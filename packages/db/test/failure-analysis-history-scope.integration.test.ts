import type { FailureAnalysisRepository } from "@autoforge/application";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresFailureAnalysisRepository } from "../src/postgres-failure-analysis";
import { SqliteFailureAnalysisRepository } from "../src/sqlite-failure-analysis";

const NOW = "2026-09-09T00:00:00.000Z";
type Execute = (sql: string, parameters: Array<string | number | null>) => Promise<void>;

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} analysis conclusion scope`,
    () => {
      it("filters by task and case before ranking, searching or applying a cursor", async () => {
        const harness = await createHarness(dialect);
        const { repository, query, ids } = harness;
        try {
          const recent = await repository.listRecentCaseHistories({
            projectId: query.projectId,
            batchId: query.batchId,
            caseDefinitionIds: [query.caseDefinitionId],
            limitPerCase: 1,
          });
          expect(recent.map((item) => item.claim.id)).toEqual([ids("history-b")]);
          const first = await repository.listCompletedConclusions({ ...query, limit: 1 });
          expect(first.items.map((item) => item.claim.id)).toEqual([ids("history-b")]);
          expect(first.nextCursor).toBeTruthy();
          const second = await repository.listCompletedConclusions({
            ...query,
            limit: 1,
            cursor: first.nextCursor!,
          });
          expect(second.items.map((item) => item.claim.id)).toEqual([ids("history-a")]);
          expect(second.nextCursor).toBeUndefined();
          expect(
            (await repository.listCompletedConclusions({ ...query, query: "other-task" })).items,
          ).toEqual([]);
          for (const override of [
            { batchId: "missing" },
            { projectId: "missing" },
            { caseDefinitionId: "missing" },
            { batchId: ids("unbound") },
          ]) {
            expect(
              (await repository.listCompletedConclusions({ ...query, ...override })).items,
            ).toEqual([]);
          }
        } finally {
          await harness.dispose();
        }
      });

      it("rejects cross-task, cross-case, missing and self inheritance without partial writes", async () => {
        const harness = await createHarness(dialect);
        const { repository, ids, completion } = harness;
        try {
          for (const source of [
            "other-task",
            "other-case",
            "target",
            "missing",
            "unbound",
            "other-project",
            "pending",
          ]) {
            await expect(
              repository.complete({
                ...completion,
                inheritedFromAnalysisId: ids(source),
              }),
            ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_INHERITANCE_SCOPE_INVALID" });
            expect((await repository.getClaim(ids("target"), DEFAULT_PROJECT_ID))?.status).toBe(
              "claimed",
            );
          }
          await expect(
            repository.complete({
              ...completion,
              analysisIds: [ids("target"), ids("other-target")],
              inheritedFromAnalysisId: ids("history-a"),
            }),
          ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_INHERITANCE_SCOPE_INVALID" });
          for (const target of ["target", "other-target"])
            expect((await repository.getClaim(ids(target), DEFAULT_PROJECT_ID))?.status).toBe(
              "claimed",
            );
          const completed = await repository.complete({
            ...completion,
            inheritedFromAnalysisId: ids("history-a"),
          });
          expect(completed).toMatchObject([{ id: ids("target"), status: "completed" }]);
        } finally {
          await harness.dispose();
        }
      });
    },
  );
}

async function createHarness(dialect: "sqlite" | "postgres") {
  const suffix = randomUUID();
  const ids = (name: string) => `${name}-${suffix}`;
  const directory = await mkdtemp(resolve(tmpdir(), "analysis-conclusion-scope-"));
  let repository: FailureAnalysisRepository;
  let execute: Execute;
  let close: () => Promise<void>;
  if (dialect === "sqlite") {
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    repository = new SqliteFailureAnalysisRepository(handle);
    execute = async (sql, parameters) => {
      handle.client.prepare(sql).run(...parameters);
    };
    close = async () => {
      handle.close();
    };
  } else {
    const handle = createPostgresDatabase({
      connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    });
    await handle.ready;
    repository = new PostgresFailureAnalysisRepository(handle);
    execute = async (sql, parameters) => {
      let index = 0;
      await handle.pool.query(
        sql.replace(/\?/gu, () => `$${++index}`),
        parameters,
      );
    };
    close = () => handle.close();
  }
  const batchIds: string[] = [];
  async function dispose() {
    try {
      for (const id of batchIds) await execute("DELETE FROM run_batches WHERE id=?", [id]);
      await execute("DELETE FROM runners WHERE id=?", [ids("runner")]);
      await execute("DELETE FROM projects WHERE id=?", [ids("project")]);
    } finally {
      await close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    await execute(
      "INSERT INTO projects (id,name,slug,created_at,updated_at) VALUES (?,'Other',?,?,?)",
      [ids("project"), ids("project"), NOW, NOW],
    );
    await execute(
      `INSERT INTO runners (id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
      VALUES (?,?,'Runner',FALSE,FALSE,'linux','amd64','1.0.0',1,'[]','[]',1,0,?,?,?)`,
      [ids("runner"), ids("credential"), NOW, NOW, NOW],
    );
    const rows = [
      { name: "history-a", suite: "suite", caseId: "case", completed: "2026-09-07T00:00:00.000Z" },
      { name: "history-b", suite: "suite", caseId: "case", completed: "2026-09-08T00:00:00.000Z" },
      { name: "other-task", suite: "other-suite", caseId: "case", completed: NOW },
      { name: "other-case", suite: "suite", caseId: "other-case", completed: NOW },
      { name: "unbound", suite: null, caseId: "case", completed: NOW },
      { name: "other-project", suite: "suite", caseId: "case", completed: NOW },
      { name: "pending", suite: "suite", caseId: "case", completed: null },
      { name: "target", suite: "suite", caseId: "case", completed: null },
      { name: "other-target", suite: "suite", caseId: "other-case", completed: null },
    ];
    for (const [sequence, row] of rows.entries()) {
      const projectId = row.name === "other-project" ? ids("project") : DEFAULT_PROJECT_ID;
      batchIds.push(ids(row.name));
      await execute(
        `INSERT INTO run_batches (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,policy_json,created_at,updated_at)
        VALUES (?,?,?,'Same display name',1,'failed',0,'[]',1,?,'{}',?,?)`,
        [ids(row.name), sequence, row.suite ? ids(row.suite) : "", projectId, NOW, NOW],
      );
      await execute(
        `INSERT INTO execution_runs (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,terminal_outcome,created_at,updated_at)
        VALUES (?,?,?,1,'Same case name','example.SameClass','failed',1,'failed',?,?)`,
        [ids(`run-${row.name}`), ids(row.name), ids(row.caseId), NOW, NOW],
      );
      await execute(
        `INSERT INTO run_attempts (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,created_at,finished_at)
        VALUES (?,?,?,1,'failed',1,'failed',?,?)`,
        [ids(`attempt-${row.name}`), ids(`run-${row.name}`), ids("runner"), NOW, NOW],
      );
      await execute(
        `INSERT INTO failure_analysis_claims (id,project_id,batch_id,execution_run_id,case_definition_id,attempt_id,case_name,class_name,attempt_number,failure_summary,status,category,claimant_id,claimant_username,claimant_display_name,claimed_at,completed_at,issue_description,ticket_reference,updated_at)
        VALUES (?,?,?,?,?,?,'Same case name','example.SameClass',1,'Failure',?,'code_issue_filed','analyst','analyst','Analyst',?,?,?,?,?)`,
        [
          ids(row.name),
          projectId,
          ids(row.name),
          ids(`run-${row.name}`),
          ids(row.caseId),
          ids(`attempt-${row.name}`),
          row.completed ? "completed" : "claimed",
          NOW,
          row.completed,
          row.name,
          "BUG-1",
          NOW,
        ],
      );
    }
    return {
      repository,
      ids,
      dispose,
      query: {
        projectId: DEFAULT_PROJECT_ID,
        batchId: ids("target"),
        caseDefinitionId: ids("case"),
        limit: 10,
      },
      completion: {
        projectId: DEFAULT_PROJECT_ID,
        claimantId: "analyst",
        analysisIds: [ids("target")],
        category: "code_issue_filed" as const,
        issueDescription: "Same failure",
        ticketReference: "BUG-1",
        rerunProofs: new Map<string, { attemptId: string; url: string }>(),
        completedAt: NOW,
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
