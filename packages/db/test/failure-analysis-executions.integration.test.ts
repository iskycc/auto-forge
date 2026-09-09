import type { FailureAnalysisRepository } from "@autoforge/application";
import { failureAnalysisExecutionHistorySchema } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresFailureAnalysisRepository } from "../src/postgres-failure-analysis";
import { SqliteFailureAnalysisRepository } from "../src/sqlite-failure-analysis";

type Execute = (sql: string, parameters: Array<string | number>) => Promise<void>;
type Harness = Awaited<ReturnType<typeof createHarness>>;
const NOW = "2026-09-07T00:00:00.000Z";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} analysis execution history`,
    () => {
      let harness: Harness;
      beforeAll(async () => {
        harness = await createHarness(dialect);
      });
      afterAll(async () => {
        await harness?.dispose();
      });

      it("returns five earlier task executions, taking the final attempt of each current round", async () => {
        const items = await harness.repository.listPreviousExecutions(harness.query);
        expect(items.map((item) => item.batchSequenceNumber)).toEqual([90, 89, 88, 87, 86]);
        expect(items.map((item) => item.outcome)).toEqual([
          "succeeded",
          "timed_out",
          "cancelled",
          "failed",
          "succeeded",
        ]);
        expect(items[0]).toMatchObject({
          caseVersion: 2,
          attemptNumber: 2,
          resultSummary: "最终结果",
        });
        expect(items[2]).not.toHaveProperty("attemptId");
        expect(items[3]?.resultSummary).toHaveLength(8192);
        expect(failureAnalysisExecutionHistorySchema.parse({ items }).items).toEqual(items);
      });

      it("finds the newest success only within each anchor's five recent task executions", async () => {
        await expect(
          harness.repository.listRecentSuccessfulExecutions({
            projectId: harness.query.projectId,
            anchors: [
              {
                referenceId: "analysis-with-history",
                batchId: harness.query.batchId,
                caseDefinitionId: harness.query.caseDefinitionId,
              },
              {
                referenceId: "analysis-without-history",
                batchId: harness.query.batchId,
                caseDefinitionId: "missing-case",
              },
              {
                referenceId: "analysis-success-outside-window",
                batchId: harness.query.batchId,
                caseDefinitionId: harness.outsideWindowCaseDefinitionId,
              },
            ],
            limitPerCase: 5,
          }),
        ).resolves.toEqual([
          {
            referenceId: "analysis-with-history",
            batchId: expect.stringContaining("batch-90-"),
            batchSequenceNumber: 90,
            createdAt: NOW,
          },
        ]);
      });

      it("returns an empty history for a missing case or an anchor outside the project", async () => {
        for (const override of [
          { projectId: harness.otherProjectId },
          { batchId: "missing-batch" },
          { caseDefinitionId: "missing-case" },
        ]) {
          await expect(
            harness.repository.listPreviousExecutions({ ...harness.query, ...override }),
          ).resolves.toEqual([]);
        }
      });
    },
  );
}

async function createHarness(dialect: "sqlite" | "postgres") {
  const suffix = randomUUID();
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-analysis-history-"));
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
      let position = 0;
      await handle.pool.query(
        sql.replace(/\?/gu, () => `$${++position}`),
        parameters,
      );
    };
    close = () => handle.close();
  }
  const suiteId = `history-suite-${suffix}`;
  const batchId = `anchor-${suffix}`;
  const caseDefinitionId = `case-${suffix}`;
  const outsideWindowCaseDefinitionId = `outside-window-case-${suffix}`;
  const runnerId = `runner-${suffix}`;
  const otherProjectId = `other-${suffix}`;
  const batchIds: string[] = [];
  async function dispose() {
    try {
      for (const id of batchIds) await execute("DELETE FROM run_batches WHERE id=?", [id]);
      await execute("DELETE FROM runners WHERE id=?", [runnerId]);
      await execute("DELETE FROM projects WHERE id=?", [otherProjectId]);
    } finally {
      await close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    await execute(
      `INSERT INTO projects (id,name,slug,created_at,updated_at) VALUES (?,'其他项目',?,?,?)`,
      [otherProjectId, otherProjectId, NOW, NOW],
    );
    await execute(
      `INSERT INTO runners
      (id,credential_hash,name,disabled,draining,os,architecture,agent_version,
       protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
      VALUES (?,?,'历史执行机',FALSE,FALSE,'linux','amd64','1.0.0',1,'[]','[]',1,0,?,?,?)`,
      [runnerId, `hash-${suffix}`, NOW, NOW, NOW],
    );
    async function seedExecution(input: {
      sequence: number;
      createdAt?: string;
      suite?: string;
      project?: string;
      kind?: string;
      caseId?: string;
      outcome?: string;
      noAttempt?: boolean;
      active?: boolean;
    }) {
      const id = input.sequence === 100 ? batchId : `batch-${input.sequence}-${suffix}`;
      const createdAt = input.createdAt ?? NOW;
      const projectId = input.project ?? DEFAULT_PROJECT_ID;
      batchIds.push(id);
      await execute(
        `INSERT INTO run_batches
        (id,sequence_number,suite_id,suite_name,suite_version,status,retry_limit,environment_json,
         total_runs,project_id,policy_json,batch_kind,current_round,created_at,updated_at)
        VALUES (?,?,?,'历史任务',1,?,1,'[]',1,?,'{}',?,2,?,?)`,
        [
          id,
          input.sequence,
          input.suite ?? suiteId,
          input.active ? "running" : "succeeded",
          projectId,
          input.kind ?? "standard",
          createdAt,
          createdAt,
        ],
      );
      const outcome = input.outcome ?? "failed";
      const runId = `run-${id}`;
      await execute(
        `INSERT INTO execution_runs
        (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,
         execution_round,terminal_outcome,created_at,updated_at)
        VALUES (?,?,?,2,'同名用例','example.Test',?,2,2,?,?,?)`,
        [
          runId,
          id,
          input.caseId ?? caseDefinitionId,
          outcome === "timed_out" ? "failed" : outcome,
          outcome,
          createdAt,
          createdAt,
        ],
      );
      if (input.noAttempt) return;
      for (const number of [1, 2]) {
        await execute(
          `INSERT INTO run_attempts
          (id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,
           execution_round,result_summary,created_at,finished_at)
          VALUES (?,?,?,?,?,1,?,?,?,?,?)`,
          [
            `attempt-${number}-${id}`,
            runId,
            runnerId,
            number,
            number === 1 ? "failed" : outcome,
            number === 1 ? "failed" : outcome,
            number,
            input.sequence === 87 ? "错".repeat(9000) : number === 1 ? "旧轮次失败" : "最终结果",
            createdAt,
            createdAt,
          ],
        );
      }
    }
    await seedExecution({ sequence: 100 });
    for (const [index, outcome] of [
      "succeeded",
      "timed_out",
      "cancelled",
      "failed",
      "succeeded",
      "failed",
    ].entries()) {
      await seedExecution({ sequence: 90 - index, outcome, noAttempt: index === 2 });
    }
    for (let index = 0; index < 6; index += 1) {
      const sequence = 90 - index;
      const historyBatchId = `batch-${sequence}-${suffix}`;
      const outcome = index === 5 ? "succeeded" : "failed";
      await execute(
        `INSERT INTO execution_runs
        (id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,
         execution_round,terminal_outcome,created_at,updated_at)
        VALUES (?,?,?,2,'窗口外成功用例','example.OutsideWindowTest',?,0,2,?,?,?)`,
        [
          `outside-window-run-${historyBatchId}`,
          historyBatchId,
          outsideWindowCaseDefinitionId,
          outcome,
          outcome,
          NOW,
          NOW,
        ],
      );
    }
    // These would be newer than the five eligible records if any scope constraint regressed.
    await seedExecution({ sequence: 101 });
    await seedExecution({ sequence: 99, createdAt: "2026-09-08T00:00:00.000Z" });
    await seedExecution({ sequence: 98, suite: "another-task" });
    await seedExecution({ sequence: 97, project: otherProjectId });
    await seedExecution({ sequence: 96, kind: "case_log_rerun" });
    await seedExecution({ sequence: 95, kind: "final_failure_rerun" });
    await seedExecution({ sequence: 94, caseId: "different-case-same-name" });
    await seedExecution({ sequence: 93, active: true });
    return {
      repository,
      otherProjectId,
      outsideWindowCaseDefinitionId,
      query: { projectId: DEFAULT_PROJECT_ID, batchId, caseDefinitionId, limit: 5 },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
