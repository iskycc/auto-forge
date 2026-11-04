import { mkdtemp, rm, mkdir, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { AiAnalysisRepository } from "@autoforge/application";
import {
  aiModelConfigurationSchema,
  type AiAnalysisJob,
  type AiConclusion,
} from "@autoforge/contracts";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase, runPostgresMigrations } from "../src/postgres-database";
import { runSqliteMigrations } from "../src/migrations";
import { SqliteAiAnalysisRepository } from "../src/sqlite-ai-analysis";
import { PostgresAiAnalysisRepository } from "../src/postgres-ai-analysis";
import { Pool } from "pg";

const now = "2026-11-04T00:00:00.000Z";
const later = "2026-11-04T00:01:00.000Z";
const projectId = "00000000-0000-7000-8000-000000000001";
const draft: AiConclusion = {
  summary: "疑似环境依赖不可用，待确认。",
  possibleCauses: ["环境服务可能未监听。"],
  checks: ["核对失败时刻监听状态。"],
  evidenceReferences: ["stderr-1"],
  limitations: [],
  confidence: "low",
};

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} AI durable work`,
    () => {
      it("selects final failures, isolates single attempts, coordinates workers, cancels late writes and exports partial snapshots", async () => {
        const suffix = randomUUID();
        const batchId = `ai-batch-${suffix}`;
        const runnerId = `ai-runner-${suffix}`;
        const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ai-"));
        const migrationFolder = resolve(
          `packages/db/drizzle/${dialect === "sqlite" ? "sqlite" : "postgresql"}`,
        );
        const baselineFolder = resolve(directory, "baseline-migrations");
        await mkdir(baselineFolder);
        for (const file of await readdir(migrationFolder)) {
          if (file.endsWith(".sql") && !file.endsWith("_ai_analysis.sql"))
            await copyFile(resolve(migrationFolder, file), resolve(baselineFolder, file));
        }
        const sqlite =
          dialect === "sqlite"
            ? createSqliteDatabase({
                databasePath: resolve(directory, "db.sqlite"),
                migrationsFolder: baselineFolder,
              })
            : undefined;
        const administration =
          dialect === "postgres"
            ? new Pool({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!, max: 1 })
            : undefined;
        const databaseName = `ai_validation_${suffix.replaceAll("-", "")}`;
        if (administration) await administration.query(`CREATE DATABASE "${databaseName}"`);
        const testUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL
          ? new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL)
          : undefined;
        if (testUrl) testUrl.pathname = `/${databaseName}`;
        const postgres =
          dialect === "postgres"
            ? createPostgresDatabase({
                connectionString: testUrl!.toString(),
                migrationsFolder: baselineFolder,
                poolMax: 2,
              })
            : undefined;
        await postgres?.ready;
        const repository: AiAnalysisRepository = sqlite
          ? new SqliteAiAnalysisRepository(sqlite)
          : new PostgresAiAnalysisRepository(postgres!);
        const execute = async (text: string, values: (string | number | null)[] = []) => {
          if (sqlite) {
            sqlite.client.prepare(text).run(...values);
            return;
          }
          let index = 0;
          await postgres!.pool.query(
            text.replaceAll("?", () => `$${++index}`),
            values,
          );
        };
        const job = (requestId: string, attemptId: string | null = null): AiAnalysisJob => ({
          id: requestId,
          batchId,
          projectId,
          attemptId,
          requestedBy: "actor",
          status: "queued",
          createdAt: now,
          updatedAt: now,
          total: 0,
          prepared: 0,
          completed: 0,
          failed: 0,
          reason: null,
          revision: 1,
        });
        try {
          await execute(
            `INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES(?,'hash','Runner',FALSE,FALSE,'linux','amd64','1.0.0',1,'[]','[]',4,0,?,?,?)`,
            [runnerId, now, now, now],
          );
          await execute(
            `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,created_at,updated_at) VALUES(?,'suite','AI test',1,'failed',1,'[]',4,?,?,?)`,
            [batchId, projectId, now, now],
          );
          for (const [name, outcomes] of [
            ["failed", ["failed", "failed"]],
            ["passed", ["failed", "succeeded"]],
            ["timeout", ["timed_out"]],
            ["cancelled", ["cancelled"]],
          ] as const) {
            const runId = `${suffix}-${name}`;
            await execute(
              `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES(?,?,?,1,?,'example.Test','failed',2,?,?)`,
              [runId, batchId, runId, name, now, now],
            );
            for (const [index, outcome] of outcomes.entries())
              await execute(
                `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_summary,created_at,finished_at) VALUES(?,?,?,?,?,1,?,'failure',?,?)`,
                [`${runId}-${index + 1}`, runId, runnerId, index + 1, outcome, outcome, now, now],
              );
          }
          if (sqlite) runSqliteMigrations(sqlite.client, migrationFolder);
          else await runPostgresMigrations(postgres!.pool, migrationFolder);
          const main = await repository.create(job(`job-${suffix}`), "manual");
          expect((await repository.create(job(`duplicate-${suffix}`), "manual")).id).toBe(main.id);
          const planning = await repository.claimPlanning("planner", now, later);
          expect(planning?.id).toBe(main.id);
          const candidates = await repository.candidates(planning!, 100);
          expect(candidates.map((item) => item.displayName).sort()).toEqual(["failed", "timeout"]);
          await repository.appendCandidates(planning!, candidates, true, now);
          const [first, second] = await Promise.all([
            repository.claimWork("worker-1", now, later),
            repository.claimWork("worker-2", now, later),
          ]);
          expect(first).not.toBeNull();
          expect(second).not.toBeNull();
          expect(first!.id).not.toBe(second!.id);
          await repository.saveEvidence(first!, "evidence.json", "stack", now);
          const ready = await repository.claimWork("worker-3", now, later);
          expect(ready!.id).toBe(first!.id);
          await repository.saveDraft(ready!, draft, 1, "已有部分初析", false, false, now);
          expect(await repository.exportConclusions(batchId, [ready!.attemptId], now)).toEqual([
            { attemptId: ready!.attemptId, conclusion: "已有部分初析" },
          ]);
          const continued = await repository.claimWork("worker-4", now, later);
          expect(continued!.partCursor).toBe(1);
          expect(
            await repository.renew(
              continued!,
              "2026-11-04T00:03:00.000Z",
              "2026-11-04T00:02:00.000Z",
            ),
          ).toBe(false);
          await repository.cancel(main.id, now);
          expect(await repository.renew(continued!, later, now)).toBe(false);
          await repository.saveDraft(
            continued!,
            draft,
            2,
            "不能发布取消后的结论",
            true,
            false,
            later,
          );
          expect(
            (await repository.exportConclusions(batchId, [ready!.attemptId], later))[0]!.conclusion,
          ).toBe("已有部分初析");
          expect((await repository.view({ batchId, jobId: main.id, limit: 10 }))!.job.status).toBe(
            "cancelled",
          );
          const attemptId = `${suffix}-passed-1`;
          await repository.create(job(`single-${suffix}`, attemptId), "single");
          const single = await repository.claimPlanning("single-planner", now, later);
          expect((await repository.candidates(single!, 100)).map((item) => item.attemptId)).toEqual(
            [attemptId],
          );
          const configuration = aiModelConfigurationSchema.parse({
            baseUrl: "http://model/v1",
            modelId: "test",
            concurrency: 1,
            requestsPerMinute: 2,
          });
          await execute("UPDATE run_batches SET policy_json=? WHERE id=?", [
            JSON.stringify({
              aiAnalysisAfterCompletion: true,
              aiAnalysisExecutionId: "source-batch",
            }),
            batchId,
          ]);
          expect(await repository.automaticCandidates(null, 10)).toEqual([]);
          await execute("UPDATE run_batches SET policy_json=? WHERE id=?", [
            JSON.stringify({ aiAnalysisAfterCompletion: true, aiAnalysisExecutionId: batchId }),
            batchId,
          ]);
          expect(
            (await repository.automaticCandidates(null, 10)).map((item) => item.batchId),
          ).toEqual([batchId]);
          await execute(
            "UPDATE ai_model_admission SET window_expires_at='',cooling_until='',requests=0,tokens=0,last_token=NULL WHERE id='default'",
          );
          const old = await repository.configuration();
          expect(
            await repository.saveConfiguration(
              { revision: old.revision + 1, configuration, encryptedKey: null },
              old.revision,
            ),
          ).toBe(true);
          expect(
            await repository.saveConfiguration(
              { revision: old.revision + 2, configuration, encryptedKey: null },
              old.revision,
            ),
          ).toBe(false);
          const reserve = (token: string) =>
            repository.reserveModel({
              token,
              revision: old.revision + 1,
              now,
              expiresAt: later,
              tokens: 100,
              configuration,
            });
          expect(await reserve(`model-1-${suffix}`)).toBe(true);
          expect(await reserve(`model-2-${suffix}`)).toBe(false);
          await repository.releaseModel(`model-1-${suffix}`);
          await repository.coolDown(later);
          expect(await reserve(`model-3-${suffix}`)).toBe(false);
        } finally {
          if (postgres) {
            await execute(
              "DELETE FROM transactional_outbox WHERE run_id IN (SELECT id FROM ai_analysis_jobs WHERE batch_id=?)",
              [batchId],
            );
            await execute("DELETE FROM run_batches WHERE id=?", [batchId]);
            await execute("DELETE FROM runners WHERE id=?", [runnerId]);
            await postgres.close();
            await administration!.query(`DROP DATABASE "${databaseName}"`);
            await administration!.end();
          }
          sqlite?.close();
          await rm(directory, { recursive: true, force: true });
        }
      }, 30000);
    },
  );
}
