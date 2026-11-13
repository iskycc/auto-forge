import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { AiAnalysisJob } from "@autoforge/contracts";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteAiAnalysisRepository } from "../src/sqlite-ai-analysis";
import { PostgresAiAnalysisRepository } from "../src/postgres-ai-analysis";

const now = "2026-11-09T00:00:00.000Z";
const second = "2026-11-09T00:01:00.000Z";
const expires = "2026-11-09T01:00:00.000Z";
const projectId = "00000000-0000-7000-8000-000000000001";

async function fixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ai-intake-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "test.sqlite"),
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
        })
      : undefined;
  const schema = `ai_intake_${randomUUID().replaceAll("-", "")}`;
  const admin = sqlite
    ? undefined
    : new Pool({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!, max: 1 });
  if (admin) await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL ?? "postgresql://localhost/test");
  url.searchParams.set("options", `-c search_path=${schema}`);
  const postgres = sqlite
    ? undefined
    : createPostgresDatabase({
        connectionString: url.toString(),
        migrationsFolder: resolve("packages/db/drizzle/postgresql"),
        poolMax: 2,
      });
  await postgres?.ready;
  const repository = sqlite
    ? new SqliteAiAnalysisRepository(sqlite)
    : new PostgresAiAnalysisRepository(postgres!);
  const query = async (
    text: string,
    values: (string | number | null)[] = [],
  ): Promise<Record<string, unknown>[]> => {
    if (sqlite) {
      const statement = sqlite.client.prepare(text);
      if (statement.reader) return statement.all(...values) as Record<string, unknown>[];
      statement.run(...values);
      return [];
    }
    let index = 0;
    return (
      await postgres!.pool.query(
        text.replaceAll("?", () => `$${++index}`),
        values,
      )
    ).rows as Record<string, unknown>[];
  };
  await query(
    `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_mode,retry_limit,current_round,environment_json,total_runs,project_id,policy_json,created_at,updated_at)
    VALUES('batch','suite','AI streaming',1,'running','round',2,3,'[]',3,?,?,?,?)`,
    [
      projectId,
      JSON.stringify({ aiAnalysisAfterCompletion: true, aiAnalysisExecutionId: "batch" }),
      now,
      now,
    ],
  );
  await query(
    `INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at)
    VALUES('runner','hash','Runner','linux','amd64','1.0',1,'[]','[]',4,0,?,?,?)`,
    [now, now, now],
  );
  const addRun = async (id: string, status: string, round: number) => {
    await query(
      `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,execution_round,held_round,created_at,updated_at)
      VALUES(?,'batch',?,1,?,'example.Failure',?,3,?,?,?,?)`,
      [id, id, id, status, round, status === "queued" ? round : 0, now, now],
    );
    await query(
      `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,execution_round,status,outcome,scheduling_score,result_summary,created_at,finished_at)
      VALUES(?,?,'runner',3,?,'failed','failed',1,'same stack',?,?)`,
      [`${id}-attempt`, id, round, now, now],
    );
  };
  const job: AiAnalysisJob = {
    id: "job",
    batchId: "batch",
    projectId,
    attemptId: null,
    requestedBy: "actor",
    strategy: "stack_groups_v2",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    total: 0,
    prepared: 0,
    completed: 0,
    failed: 0,
    reason: null,
    revision: 1,
  };
  return {
    repository,
    query,
    addRun,
    job,
    close: async () => {
      sqlite?.close();
      await postgres?.close();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} progressive final-round AI`,
    () => {
      it("defers unlimited automatic analysis until the execution is terminal", async () => {
        const context = await fixture(dialect);
        try {
          await context.query(
            "UPDATE run_batches SET current_round=10000,policy_json=? WHERE id='batch'",
            [
              JSON.stringify({
                unlimitedRetries: true,
                aiAnalysisAfterCompletion: true,
                aiAnalysisExecutionId: "batch",
              }),
            ],
          );
          expect(await context.repository.automaticCandidates(null, 10)).toEqual([]);
          await context.query("UPDATE run_batches SET status='succeeded' WHERE id='batch'");
          expect(
            (await context.repository.automaticCandidates(null, 10)).map((item) => item.batchId),
          ).toEqual(["batch"]);
        } finally {
          await context.close();
        }
      });
      it.each([0, 1])(
        "keeps intake open when the last case finishes between reading %i candidates and committing the plan",
        async (alreadyFinished) => {
          const context = await fixture(dialect);
          const { repository, query, job } = context;
          try {
            if (alreadyFinished) await context.addRun("z-early", "failed", 3);
            await context.addRun("a-late", "queued", 3);
            await repository.create(job, "automatic", { followFinalResults: true });
            const planning = await repository.claimPlanning("planner", now, expires);
            const candidates = await repository.candidates(planning!, 100);
            expect(candidates).toHaveLength(alreadyFinished);

            // Completion commits after the page read, before the planning write transaction.
            await query("UPDATE execution_runs SET status='failed',held_round=0 WHERE id='a-late'");
            await query("UPDATE run_batches SET status='failed' WHERE id='batch'");
            await repository.appendCandidates(planning!, candidates, true, now);
            expect((await repository.view({ batchId: "batch", limit: 10 }))?.job).toMatchObject({
              total: alreadyFinished,
              acceptingFinalResults: true,
            });
            if (alreadyFinished) {
              const work = await repository.claimWork("collector", now, expires);
              await repository.saveEvidence(work!, "evidence", "exact-stack-bundle-v2:race", now);
              await repository.prepareGroups(now);
              const group = await repository.claimGroup("model", now, expires);
              await repository.saveStackGroup(
                group!,
                {
                  cursor: "",
                  partCursor: 0,
                  processed: 1,
                  conclusion: "初步建议",
                  done: true,
                },
                now,
              );
            }
            await repository.prepareGroups(now);
            const resumed = await repository.claimPlanning("resumed", second, expires);
            expect(resumed?.intakeOpen).toBe(true);
            const late = await repository.candidates(resumed!, 100);
            expect(late.map((item) => item.executionRunId)).toEqual(["a-late"]);
            await repository.appendCandidates(resumed!, late, true, second);
            const view = (await repository.view({ batchId: "batch", limit: 10 }))!;
            expect(view.job.total).toBe(alreadyFinished + 1);
            expect(view.job.acceptingFinalResults).toBeUndefined();
            expect(view.items.map((item) => item.executionRunId)).toContain("a-late");
          } finally {
            await context.close();
          }
        },
      );

      it("analyzes final cases while execution continues, includes late lower IDs, and republishes a common stack conclusion without double counting", async () => {
        const context = await fixture(dialect);
        const { repository, query, job } = context;
        try {
          await context.addRun("z-early", "failed", 3);
          await context.addRun("a-late", "queued", 3);
          expect(
            (await repository.automaticCandidates(null, 10)).map((item) => item.batchId),
          ).toEqual(["batch"]);
          await repository.create(job, "automatic", { followFinalResults: true });
          const processWave = async (
            time: string,
            expectedRun: string,
            expectedCount: number,
            conclusion: string,
          ) => {
            const planning = await repository.claimPlanning(`planner-${time}`, time, expires);
            expect(planning).toMatchObject({ id: job.id, intakeOpen: true });
            const candidates = await repository.candidates(planning!, 100);
            expect(candidates.map((item) => item.executionRunId)).toEqual([expectedRun]);
            await repository.appendCandidates(planning!, candidates, true, time);
            const work = await repository.claimWork(`worker-${time}`, time, expires);
            expect(work?.executionRunId).toBe(expectedRun);
            await repository.saveEvidence(
              work!,
              `evidence-${expectedRun}`,
              "exact-stack-bundle-v2:identical",
              time,
            );
            await repository.prepareGroups(time);
            const group = await repository.claimGroup(`model-${time}`, time, expires);
            expect(group?.memberCount).toBe(expectedCount);
            const members = await repository.groupMembers(group!, 50);
            await repository.saveStackGroup(
              group!,
              {
                cursor: members.at(-1)!.id,
                partCursor: 0,
                processed: expectedCount,
                conclusion,
                done: true,
              },
              time,
            );
            await repository.prepareGroups(time);
            return (await repository.view({ batchId: "batch", jobId: job.id, limit: 10 }))!;
          };
          const first = await processWave(now, "z-early", 1, "可能重跑通过：环境瞬时异常");
          expect(first.job).toMatchObject({ status: "queued", total: 1, completed: 1 });
          expect((await query("SELECT status FROM run_batches WHERE id='batch'"))[0]!.status).toBe(
            "running",
          );
          expect(await repository.claimPlanning("too-early", now, expires)).toBeNull();
          expect(await repository.automaticCandidates(null, 10)).toEqual([]);
          // Restart-safe discovery uses the persisted item ledger, not an ID watermark.
          await query("UPDATE execution_runs SET status='failed',held_round=0 WHERE id='a-late'");
          await query("UPDATE run_batches SET status='failed' WHERE id='batch'");
          const last = await processWave(
            second,
            "a-late",
            2,
            "可能业务问题需要提单：同栈日志共同证据",
          );
          expect(last.job).toMatchObject({
            status: "completed",
            total: 2,
            prepared: 2,
            completed: 2,
            failed: 0,
          });
          expect(last.items.map((item) => item.conclusion)).toEqual(
            Array(2).fill("可能业务问题需要提单：同栈日志共同证据"),
          );
          expect(await repository.exportConclusions("batch", ["z-early-attempt"], now)).toEqual([
            { attemptId: "z-early-attempt", conclusion: "可能重跑通过：环境瞬时异常" },
          ]);
          expect(
            await repository.exportConclusions(
              "batch",
              ["z-early-attempt", "a-late-attempt"],
              expires,
            ),
          ).toEqual(
            expect.arrayContaining([
              {
                attemptId: "z-early-attempt",
                conclusion: "可能业务问题需要提单：同栈日志共同证据",
              },
              { attemptId: "a-late-attempt", conclusion: "可能业务问题需要提单：同栈日志共同证据" },
            ]),
          );
        } finally {
          await context.close();
        }
      });

      it("reuses a published large exact-stack group for late members and closes an all-pass intake without model work", async () => {
        const context = await fixture(dialect);
        const { repository, query, job } = context;
        try {
          for (let index = 0; index < 10; index++)
            await context.addRun(`ready-${index}`, "failed", 3);
          await context.addRun("a-last", "queued", 3);
          await repository.create(job, "automatic", { followFinalResults: true });
          const plan = await repository.claimPlanning("large-plan", now, expires);
          const candidates = await repository.candidates(plan!, 100);
          expect(candidates).toHaveLength(10);
          await repository.appendCandidates(plan!, candidates, true, now);
          for (let index = 0; index < 10; index++) {
            const work = await repository.claimWork(`collect-${index}`, now, expires);
            await repository.saveEvidence(
              work!,
              `evidence-${index}`,
              "exact-stack-bundle-v2:large",
              now,
            );
          }
          await repository.prepareGroups(now);
          const group = await repository.claimGroup("large-model", now, expires);
          expect(group?.memberCount).toBe(10);
          await repository.saveStackGroup(
            group!,
            { cursor: "", partCursor: 0, processed: 10, conclusion: "共同建议", done: true },
            now,
          );
          await repository.prepareGroups(now);
          await query("UPDATE execution_runs SET status='failed',held_round=0 WHERE id='a-last'");
          await query("UPDATE run_batches SET status='failed' WHERE id='batch'");
          const latePlan = await repository.claimPlanning("late-plan", second, expires);
          const late = await repository.candidates(latePlan!, 100);
          expect(late.map((item) => item.executionRunId)).toEqual(["a-last"]);
          await repository.appendCandidates(latePlan!, late, true, second);
          const lateWork = await repository.claimWork("late-evidence", second, expires);
          await repository.saveEvidence(
            lateWork!,
            "late-evidence",
            "exact-stack-bundle-v2:large",
            second,
          );
          await Promise.all([repository.prepareGroups(second), repository.prepareGroups(second)]);
          expect(await repository.claimGroup("no-extra-model", second, expires)).toBeNull();
          await repository.prepareGroups(second);
          const view = (await repository.view({ batchId: "batch", jobId: job.id, limit: 100 }))!;
          expect(view.job).toMatchObject({
            status: "completed",
            total: 11,
            prepared: 11,
            completed: 11,
            failed: 0,
          });
          expect(view.items.every((item) => item.conclusion === "共同建议")).toBe(true);

          await query("UPDATE execution_runs SET status='succeeded' WHERE batch_id='batch'");
          const allPass = await repository.create(
            { ...job, id: "all-pass" },
            "automatic-all-pass",
            { followFinalResults: true },
          );
          const empty = await repository.claimPlanning("all-pass-planner", second, expires);
          expect(await repository.candidates(empty!, 100)).toEqual([]);
          await repository.appendCandidates(empty!, [], true, second);
          await repository.prepareGroups(second);
          expect(
            (await repository.view({ batchId: "batch", jobId: allPass.id, limit: 10 }))?.job,
          ).toMatchObject({ status: "completed", total: 0 });
          expect(await repository.claimWork("no-model", second, expires)).toBeNull();
        } finally {
          await context.close();
        }
      });

      it("does not create empty final rounds or close an empty intake while executions can still finish; cancellation fences later writes", async () => {
        const context = await fixture(dialect);
        const { repository, query, job } = context;
        try {
          await query("UPDATE run_batches SET current_round=2 WHERE id='batch'");
          expect(await repository.automaticCandidates(null, 10)).toEqual([]);
          await query("UPDATE run_batches SET current_round=3 WHERE id='batch'");
          await context.addRun("retry-pending", "queued", 3);
          await query(
            `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,execution_round,created_at,updated_at)
            VALUES('no-attempt','batch','no-attempt',1,'queue timeout','example.Timeout','failed',0,3,?,?)`,
            [now, now],
          );
          await repository.create(job, "automatic", { followFinalResults: true });
          const plan = await repository.claimPlanning("empty", now, expires);
          expect(await repository.candidates(plan!, 100)).toEqual([]);
          await repository.appendCandidates(plan!, [], true, now);
          await repository.prepareGroups(now);
          expect((await repository.view({ batchId: "batch", limit: 10 }))?.job).toMatchObject({
            status: "queued",
            total: 0,
          });
          await query("UPDATE run_batches SET status='cancelled' WHERE id='batch'");
          const next = await repository.claimPlanning("cancelled-planner", second, expires);
          expect(await repository.candidates(next!, 100)).toContainEqual({
            executionRunId: "no-attempt",
            attemptId: "",
            displayName: "queue timeout",
          });
          await repository.cancel(job.id, second);
          await repository.appendCandidates(
            next!,
            [
              {
                executionRunId: "retry-pending",
                attemptId: "retry-pending-attempt",
                displayName: "pending",
              },
            ],
            true,
            second,
          );
          expect((await repository.view({ batchId: "batch", limit: 10 }))?.job).toMatchObject({
            status: "cancelled",
            total: 0,
          });
        } finally {
          await context.close();
        }
      });
    },
  );
}
