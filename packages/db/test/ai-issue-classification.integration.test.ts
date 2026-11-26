import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  AiAnalysisWorker,
  AiModelRequestError,
  type AiEvidencePort,
  type AiModelGatewayPort,
  type IdentityAccessRepository,
  type SecretCipherPort,
} from "@autoforge/application";
import {
  AI_BATCH_CLASSIFICATION_STRATEGY,
  aiModelConfigurationSchema,
  type AiAnalysisJob,
} from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase, SqliteAiAnalysisRepository } from "@autoforge/db/sqlite";
import { createPostgresDatabase, PostgresAiAnalysisRepository } from "@autoforge/db/postgres";
import { runSqliteMigrations } from "../src/migrations";
import { runPostgresMigrations } from "../src/postgres-database";

const initialTime = Date.parse("2026-11-25T00:00:00Z");
const batchId = "batch";
const projectId = DEFAULT_PROJECT_ID;
const cases = [
  ...Array.from({ length: 5 }, () => ({ stack: "A", cause: "wallet" })),
  ...Array.from({ length: 4 }, () => ({ stack: "A", cause: "test-data" })),
  { stack: "A", cause: "permissions" },
  ...Array.from({ length: 6 }, () => ({ stack: "B", cause: "service" })),
  ...Array.from({ length: 4 }, () => ({ stack: "C", cause: "short-stack" })),
].map((value, index) => ({ ...value, id: `run-${String(index).padStart(2, "0")}`, index }));

for (const mode of ["sqlite", "postgres"] as const) {
  describe.skipIf(mode === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(mode, () => {
    it("refines identical stacks by actual cause, ranks stable groups, and protects the common export", async () => {
      const db = await openDatabase(mode);
      const analysis = db.repository;
      let time = initialTime;
      const now = () => new Date(time).toISOString();
      const configuration = aiModelConfigurationSchema.parse({
        enabled: true,
        baseUrl: "http://model/v1",
        modelId: "local-fixture",
        requestsPerMinute: 200,
        tokensPerMinute: 2_000_000,
      });
      const job: AiAnalysisJob = {
        id: "classified-job",
        batchId,
        projectId,
        attemptId: null,
        requestedBy: "actor",
        status: "queued",
        strategy: AI_BATCH_CLASSIFICATION_STRATEGY,
        total: 0,
        completed: 0,
        prepared: 0,
        failed: 0,
        reason: null,
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      const coarse: Array<{ stack: string; count: number }> = [];
      const comparisons = new Map<string, number[]>();
      const independent = new Set<string>();
      const output = (cause: string, reference: string, detail = "") => ({
        recommendation: "case_change_likely",
        reason: `${cause}${detail}`,
        evidence: `证据对应 ${cause}。`,
        evidenceReferences: [reference],
      });
      let throttled = false;
      let cancelDuringRefinement = false;
      let modelCalls = 0;
      const model: AiModelGatewayPort = {
        async complete({ messages, tools }) {
          modelCalls++;
          const context = JSON.parse(messages.find((message) => message.role === "user")!.content!);
          const evidence = JSON.parse(
            messages.find((message) => message.role === "tool")!.content!,
          );
          const toolName = tools[0]!.function.name;
          let reply: unknown;
          if (toolName === "classify_ai_stacks") {
            if (!throttled) {
              throttled = true;
              throw new AiModelRequestError("fixture rate limit", true, 100);
            }
            coarse.push(...evidence.stacks);
            reply = {
              categories: evidence.stacks.map((stack: { stackId: string; stack: string }) => ({
                stackId: stack.stackId,
                summary: `暂定问题 ${stack.stack}`,
              })),
            };
          } else {
            const [cause, caseId] = evidence.text.split(":") as [string, string];
            if (toolName === "submit_ai_issue") {
              if (cancelDuringRefinement) {
                cancelDuringRefinement = false;
                await analysis.cancel("cancelled-classification", now());
              }
              if (caseId === "run-03") expect(context.previousPart?.reason).toBe(cause);
              const prior = context.existingCategories as Array<{
                categoryId: string;
                summary: string;
              }>;
              comparisons.set(caseId, [...(comparisons.get(caseId) ?? []), prior.length]);
              const match = prior.find((candidate) => candidate.summary === cause);
              const improvesConclusion = caseId === "run-02";
              reply = {
                summary: match && !improvesConclusion ? "模型重复填写了本例简述" : cause,
                categoryId: match?.categoryId ?? null,
                useExistingConclusion: !!match && !improvesConclusion,
                conclusion: output(
                  cause,
                  evidence.evidenceId,
                  improvesConclusion ? "，由网关日志进一步确认" : "",
                ),
              };
            } else {
              if (context.stage === "independent_issue_member") independent.add(caseId);
              reply = output(cause, evidence.evidenceId);
            }
          }
          return {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "verdict",
                type: "function",
                function: { name: toolName, arguments: JSON.stringify(reply) },
              },
            ],
          };
        },
      };
      const evidence: AiEvidencePort = {
        async collect(work) {
          return { key: work.executionRunId, evidence: await this.read(work.executionRunId) };
        },
        async read(key) {
          const member = cases.find((item) => item.id === key)!;
          const parts = [
            { id: "stdout-1", objectKey: `${member.cause}:${member.id}`, sizeBytes: 32 },
          ];
          if (member.index === 3) parts.push({ ...parts[0]!, id: "stdout-2" });
          return {
            version: 1,
            executionRunId: member.id,
            attemptId: `attempt-${member.id}`,
            parts,
            limitations: [],
            stdoutComplete: true,
            signature: `stack-line-v3:${member.stack}`,
            stackLine: member.stack,
          };
        },
        part: async (part) => part.objectKey,
      };
      const createWorker = () =>
        new AiAnalysisWorker(
          analysis,
          evidence,
          model,
          {
            findUser: async () => ({ id: "actor", status: "active" }),
            listRoles: async () => [
              {
                id: "role",
                active: true,
                permissions: ["analysis.ai.create", "run.read", "case.read", "log.read"],
              },
            ],
            listSystemRoleBindings: async () => [{ roleId: "role" }],
            listUserProjectRoleBindings: async () => [],
          } as unknown as IdentityAccessRepository,
          {} as SecretCipherPort,
          { now: () => new Date(time) },
          { next: randomUUID },
          () => true,
          (error) => {
            throw error;
          },
        );

      try {
        await db.query(
          "INSERT INTO runners(id,credential_hash,name,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES ('runner','hash','runner','linux','amd64','1.0.0',1,'[]','[]',1,0,?,?,?)",
          [now(), now(), now()],
        );
        await db.query(
          "INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,created_at,updated_at) VALUES (?,'suite','fixture',1,'failed',0,'[]',?,?,?,?)",
          [batchId, cases.length, projectId, now(), now()],
        );
        for (const member of cases) {
          await db.query(
            "INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES (?,?,?,1,?,'example.Test','failed',1,?,?)",
            [member.id, batchId, member.id, member.id, now(), now()],
          );
          await db.query(
            "INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,outcome,scheduling_score,created_at,finished_at) VALUES (?,?,'runner',1,'failed','failed',1,?,?)",
            [`attempt-${member.id}`, member.id, now(), now()],
          );
        }
        await db.query(
          "INSERT INTO ai_analysis_jobs(id,batch_id,project_id,requested_by,request_key,status,strategy,created_at,updated_at) VALUES ('old-job',?,?,'actor','previous','completed','stack_groups_v2',?,?)",
          [batchId, projectId, now(), now()],
        );
        await db.query(
          "INSERT INTO ai_analysis_items(id,job_id,execution_run_id,attempt_id,display_name,status,available_at,created_at,updated_at) VALUES ('old-item','old-job','run-00','attempt-run-00','旧用例','completed',?,?,?)",
          [now(), now(), now()],
        );
        await db.query(
          "INSERT INTO ai_analysis_conclusions(id,item_id,batch_id,attempt_id,conclusion,created_at) VALUES ('old-conclusion','old-item',?,'attempt-run-00','旧初析结论',?)",
          [batchId, now()],
        );
        await db.upgrade();
        expect(await analysis.exportConclusions(batchId, ["attempt-run-00"], now())).toEqual([
          { attemptId: "attempt-run-00", conclusion: "旧初析结论" },
        ]);
        expect(
          await analysis.saveConfiguration({ revision: 1, configuration, encryptedKey: null }, 0),
        ).toBe(true);
        await analysis.create(job, "classified");
        const signal = new AbortController().signal;
        for (let tick = 0; tick < 130; tick++) {
          // Recreate the worker to exercise the persisted cursors at every phase boundary.
          await createWorker().tick(signal);
          const view = await analysis.view({ batchId, jobId: job.id, limit: 100 });
          if (view?.job.status === "completed") break;
          time += 250;
        }
        expect((await analysis.view({ batchId, jobId: job.id, limit: 100 }))?.job).toMatchObject({
          status: "completed",
          completed: 20,
          prepared: 20,
          failed: 0,
          classificationReviewed: 16,
        });
        expect(
          coarse
            .map(({ stack, count }) => ({ stack, count }))
            .sort((a, b) => a.stack.localeCompare(b.stack)),
        ).toEqual([
          { stack: "A", count: 10 },
          { stack: "B", count: 6 },
        ]);
        expect(comparisons.get("run-05")).toEqual([1]);
        expect(comparisons.get("run-09")).toEqual([2]);
        expect(comparisons.get("run-03")).toEqual([1]);
        expect([...independent].sort()).toEqual(
          cases
            .filter((item) => !["wallet", "service"].includes(item.cause))
            .map((item) => item.id),
        );

        const latest = await analysis.exportClassificationJob(batchId, now());
        expect(latest).toBe(job.id);
        const original = await analysis.exportConclusions(
          batchId,
          cases.map(({ id }) => `attempt-${id}`),
          now(),
          latest!,
        );
        const wallet = original.filter(({ category }) => category?.rank === 2);
        expect(wallet).toHaveLength(5);
        expect(new Set(wallet.map(({ conclusion }) => conclusion)).size).toBe(1);
        expect(wallet[0]?.conclusion).toContain("进一步确认");
        expect(wallet.every(({ category }) => category?.summary === "wallet")).toBe(true);
        expect(original.filter(({ category }) => category?.rank === 1)).toHaveLength(6);
        expect(
          original.filter(({ category }) => category?.rank === 0 && category.summary === ""),
        ).toHaveLength(9);

        time += 250;
        const singleTime = now();
        await analysis.create(
          {
            ...job,
            id: "standalone",
            attemptId: "attempt-run-00",
            strategy: "single_full_v2",
            createdAt: singleTime,
            updatedAt: singleTime,
          },
          "standalone",
        );
        for (let tick = 0; tick < 6; tick++) await createWorker().tick(signal);
        const standalone = (await analysis.view({ batchId, jobId: "standalone", limit: 1 }))!;
        expect(standalone.items[0]?.conclusion).not.toContain("进一步确认");
        expect(
          await analysis.exportConclusions(batchId, ["attempt-run-00"], now(), latest!),
        ).toEqual(wallet.filter(({ attemptId }) => attemptId === "attempt-run-00"));

        time += 1000;
        await analysis.create(
          { ...job, id: "cancelled-classification", createdAt: now(), updatedAt: now() },
          "cancel-during-refinement",
        );
        cancelDuringRefinement = true;
        for (let tick = 0; tick < 45 && cancelDuringRefinement; tick++) {
          await createWorker().tick(signal);
          time += 250;
        }
        const cancelled = (await analysis.view({
          batchId,
          jobId: "cancelled-classification",
          limit: 100,
        }))!;
        expect(cancelled.job).toMatchObject({ status: "cancelled", classificationReviewed: 0 });
        expect(cancelled.items.every((member) => member.conclusion === null)).toBe(true);

        await db.query("UPDATE execution_runs SET status='succeeded'", []);
        await db.query("UPDATE run_attempts SET status='succeeded', outcome='succeeded'", []);
        await analysis.create(
          { ...job, id: "all-passed", createdAt: now(), updatedAt: now() },
          "all-passed",
        );
        const callsBeforeAllPassed = modelCalls;
        for (let tick = 0; tick < 8; tick++) await createWorker().tick(signal);
        const allPassed = await analysis.view({ batchId, jobId: "all-passed", limit: 1 });
        expect(allPassed?.job).toMatchObject({ status: "completed", total: 0, completed: 0 });
        expect(allPassed?.items).toEqual([]);
        expect(modelCalls).toBe(callsBeforeAllPassed);
      } finally {
        await db.close();
      }
    }, 45000);
  });
}

async function openDatabase(mode: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ai-classification-"));
  const migrationsFolder = resolve(
    "packages/db/drizzle",
    mode === "sqlite" ? "sqlite" : "postgresql",
  );
  const previousMigrations = resolve(directory, "previous");
  await mkdir(previousMigrations);
  for (const file of await readdir(migrationsFolder)) {
    if (file.endsWith(".sql") && file < "0105_")
      await copyFile(resolve(migrationsFolder, file), resolve(previousMigrations, file));
  }
  if (mode === "sqlite") {
    const database = createSqliteDatabase({
      databasePath: resolve(directory, "test.db"),
      migrationsFolder: previousMigrations,
    });
    return {
      repository: new SqliteAiAnalysisRepository(database),
      upgrade: async () => runSqliteMigrations(database.client, migrationsFolder),
      query: async (statement: string, parameters: (string | number)[]) =>
        database.client.prepare(statement).run(...parameters),
      close: async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const databaseName = `ai_classification_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  url.pathname = `/${databaseName}`;
  const database = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: previousMigrations,
    poolMax: 2,
  });
  await database.ready;
  return {
    repository: new PostgresAiAnalysisRepository(database),
    upgrade: () => runPostgresMigrations(database.pool, migrationsFolder),
    query: async (statement: string, parameters: (string | number)[]) => {
      let index = 0;
      return database.pool.query(
        statement.replaceAll("?", () => `$${++index}`),
        parameters,
      );
    },
    close: async () => {
      await database.close();
      await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
