import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { Pool } from "pg";
import { connect } from "nats";
import { createClient } from "redis";
import { describe, it, expect } from "vitest";
import {
  createPostgresDatabase,
  PostgresIdentityAccessRepository,
  PostgresAiAnalysisRepository,
} from "@autoforge/db/postgres";
import { MinioObjectStore } from "@autoforge/object-store/minio";
import { JetStreamJobQueue } from "@autoforge/queue/jetstream";
import { PostgresOutboxRelay } from "@autoforge/queue/outbox";
import { namespacedKey } from "@autoforge/cache/memory";
import { builtInRoleDefinitions, DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import { AiAnalysisWorkerHost } from "./ai-analysis-worker-host";

const enabled = [
  "AUTOFORGE_TEST_POSTGRES_URL",
  "AUTOFORGE_TEST_MINIO_ENDPOINT",
  "AUTOFORGE_TEST_MINIO_ACCESS_KEY",
  "AUTOFORGE_TEST_MINIO_SECRET_KEY",
  "AUTOFORGE_TEST_REDIS_URL",
  "AUTOFORGE_TEST_NATS_URL",
].every((key) => !!process.env[key]);
describe.skipIf(!enabled)("Full AI workers with real middleware", () => {
  it.each(["legacy", "stack_groups_v2"] as const)(
    "uses outbox/NATS, two isolated workers, Redis and MinIO with %s without changing execution facts",
    async (strategy) => {
      const suffix = randomUUID().replaceAll("-", "");
      const now = new Date().toISOString();
      const databaseName = `ai_runtime_${suffix}`;
      const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
      const administration = new Pool({ connectionString: url.toString(), max: 1 });
      await administration.query(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      const handle = createPostgresDatabase({
        connectionString: url.toString(),
        migrationsFolder: resolve("packages/db/drizzle/postgresql"),
        poolMax: 2,
      });
      await handle.ready;
      const directory = await mkdtemp(resolve(tmpdir(), "autoforge-ai-full-"));
      const endpoint = new URL(process.env.AUTOFORGE_TEST_MINIO_ENDPOINT!);
      const options = {
        endPoint: endpoint.hostname,
        port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
        useSSL: endpoint.protocol === "https:",
        accessKey: process.env.AUTOFORGE_TEST_MINIO_ACCESS_KEY!,
        secretKey: process.env.AUTOFORGE_TEST_MINIO_SECRET_KEY!,
        bucket: `ai-${suffix}`,
        region: "us-east-1",
      };
      const { Client } = createRequire(resolve("packages/object-store/package.json"))("minio") as {
        Client: new (configuration: typeof options) => {
          makeBucket(bucket: string, region: string): Promise<void>;
          removeBucket(bucket: string): Promise<void>;
        };
      };
      const client = new Client(options);
      await client.makeBucket(options.bucket, "us-east-1");
      const objects = new MinioObjectStore(options);
      const redis = createClient({
        url: process.env.AUTOFORGE_TEST_REDIS_URL!,
        socket: { reconnectStrategy: false },
        disableOfflineQueue: true,
      });
      const errors: unknown[] = [];
      redis.on("error", (error) => errors.push(error));
      await redis.connect();
      const nats = await connect({ servers: process.env.AUTOFORGE_TEST_NATS_URL! });
      const queue = await JetStreamJobQueue.create(
        nats.jetstream(),
        await nats.jetstreamManager(),
        {
          namespace: `ai-${suffix.slice(0, 24)}`,
        },
      );
      let active = 0;
      let peak = 0;
      let modelCalls = 0;
      let releaseInitialPair: () => void = () => {};
      const initialPair = new Promise<void>((resolvePair) => {
        releaseInitialPair = resolvePair;
      });
      const model = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const read = body.messages.findLast((message: { role: string }) => message.role === "tool");
        const ref = JSON.parse(read.content).evidenceId;
        active++;
        peak = Math.max(peak, active);
        modelCalls++;
        const callNumber = modelCalls;
        if (active === 2) releaseInitialPair();
        // Hold the first request until both workers participate; startup speed is irrelevant.
        if (callNumber <= 2) await initialPair;
        active--;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: randomUUID(),
                      type: "function",
                      function: {
                        name: "submit_ai_conclusion",
                        arguments: JSON.stringify(
                          strategy === "stack_groups_v2"
                            ? {
                                recommendation: "rerun_likely",
                                reason: "Full 合成初析，待验证。",
                                evidence: "共同堆栈显示依赖连接异常。",
                                evidenceReferences: [ref],
                              }
                            : {
                                summary: "Full 合成初析，待验证。",
                                possibleCauses: ["相同堆栈不代表根因已确认。"],
                                checks: ["核对每个成员的环境和输入差异。"],
                                evidenceReferences: [ref],
                                limitations: [],
                                confidence: "low",
                              },
                        ),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      });
      await new Promise<void>((resolveListen) => model.listen(0, "127.0.0.1", resolveListen));
      const address = model.address();
      if (!address || typeof address === "string") throw new Error("Missing model port.");
      const hosts: AiAnalysisWorkerHost[] = [];
      try {
        const identities = new PostgresIdentityAccessRepository(handle);
        await identities.ensureBuiltInRoles(builtInRoleDefinitions, now);
        const actorId = randomUUID();
        await identities.createLocalUser({
          id: actorId,
          username: `ai-${suffix}`,
          normalizedUsername: `ai-${suffix}`,
          displayName: "AI 验收",
          passwordHash: "not-a-login-credential",
          forcePasswordChange: false,
          createdAt: now,
        });
        await identities.assignSystemRole(actorId, builtInRoleDefinitions[0]!.id, actorId, now);
        const runnerId = randomUUID();
        const batchId = randomUUID();
        await handle.pool.query(
          `INSERT INTO runners(id,credential_hash,name,disabled,draining,os,architecture,agent_version,protocol_version,labels_json,capabilities_json,max_concurrency,busy_slots,last_seen_at,created_at,updated_at) VALUES($1,'hash','Runner',FALSE,FALSE,'linux','amd64','1.0.0',1,'[]','[]',4,0,$2,$2,$2)`,
          [runnerId, now],
        );
        await handle.pool.query(
          `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,created_at,updated_at) VALUES($1,'suite','Full AI test',1,'failed',0,'[]',4,$2,$3,$3)`,
          [batchId, DEFAULT_PROJECT_ID, now],
        );
        for (let index = 0; index < 4; index++) {
          const runId = `run-${index}-${suffix}`;
          const attemptId = `attempt-${index}-${suffix}`;
          await handle.pool.query(
            `INSERT INTO execution_runs(id,batch_id,case_definition_id,case_version,display_name,class_name,status,attempt_count,created_at,updated_at) VALUES($1,$2,$1,1,$3,'example.Test','failed',1,$4,$4)`,
            [runId, batchId, `Case ${index}`, now],
          );
          await handle.pool.query(
            `INSERT INTO run_attempts(id,execution_run_id,runner_id,attempt_number,status,scheduling_score,outcome,result_summary,created_at,finished_at) VALUES($1,$2,$3,1,'failed',1,'failed','failure',$4,$4)`,
            [attemptId, runId, runnerId, now],
          );
        }
        const repository = new PostgresAiAnalysisRepository(handle);
        const configuration = aiModelConfigurationSchema.parse({
          enabled: true,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: "fixture",
          concurrency: 2,
          requestsPerMinute: 120,
          tokensPerMinute: 1000000,
          timeoutSeconds: 10,
        });
        await repository.saveConfiguration({ revision: 1, configuration, encryptedKey: null }, 0);
        const job = await repository.create(
          {
            id: randomUUID(),
            batchId,
            projectId: DEFAULT_PROJECT_ID,
            requestedBy: actorId,
            attemptId: null,
            strategy,
            status: "queued",
            createdAt: now,
            updatedAt: now,
            total: 0,
            prepared: 0,
            completed: 0,
            failed: 0,
            reason: null,
            revision: 1,
          },
          "full-runtime",
        );
        const planning = (await repository.claimPlanning(
          "planner",
          now,
          new Date(Date.now() + 30000).toISOString(),
        ))!;
        await repository.appendCandidates(
          planning,
          await repository.candidates(planning, 100),
          true,
          now,
        );
        const put = async (key: string, value: unknown) => {
          const content = Buffer.from(JSON.stringify(value));
          await objects.putObject({
            objectKey: key,
            content: (async function* () {
              yield content;
            })(),
            sizeBytes: content.length,
            sha256: createHash("sha256").update(content).digest("hex"),
            mediaType: "application/json",
          });
        };
        const evidenceWorks = [];
        for (let index = 0; index < 4; index++)
          evidenceWorks.push(
            (await repository.claimWork(
              randomUUID(),
              now,
              new Date(Date.now() + 30000).toISOString(),
            ))!,
          );
        for (const [index, work] of evidenceWorks.entries()) {
          const partKey = `ai-fixture/${suffix}/${index}.txt`;
          const manifestKey = `ai-fixture/${suffix}/${index}.json`;
          await put(partKey, {
            text: "java.lang.AssertionError: expected 1\n\tat example.Test.run(Test.java:20)\n",
            member: work.executionRunId,
          });
          await put(manifestKey, {
            version: 1,
            inputPolicy: "stdout_business_v1",
            stdoutComplete: true,
            executionRunId: work.executionRunId,
            attemptId: work.attemptId,
            signature:
              strategy === "legacy"
                ? "same-stack-fixture"
                : `exact-stack-bundle-v1:fixture-${Math.floor(index / 2)}`,
            limitations: [],
            stackParts: [{ id: `part-${index}`, objectKey: partKey, sizeBytes: 100 }],
            parts: [{ id: `part-${index}`, objectKey: partKey, sizeBytes: 100 }],
          });
          await repository.saveEvidence(
            work,
            manifestKey,
            strategy === "legacy"
              ? "same-stack-fixture"
              : `exact-stack-bundle-v1:fixture-${Math.floor(index / 2)}`,
            now,
          );
        }
        const relay = new PostgresOutboxRelay(
          handle,
          queue,
          { workerId: "ai-relay", leaseDurationMs: 30000, pollIntervalMs: 100, batchSize: 10 },
          { info: () => undefined, error: (error) => errors.push(error) },
          { now: () => new Date() },
        );
        expect(await relay.relayOnce(new Date())).toBe(1);
        const wake = await queue.claim({
          workerId: "ai-wakeup",
          now: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
          limit: 1,
          workClass: "background",
        });
        expect(wake[0]?.job.kind).toBe("ai-analysis-wakeup");
        await queue.acknowledge({
          workerId: "ai-wakeup",
          deliveryId: wake[0]!.deliveryId,
          acknowledgedAt: new Date().toISOString(),
        });
        const masterKey = randomBytes(32).toString("base64");
        for (let index = 0; index < 2; index++)
          hosts.push(
            new AiAnalysisWorkerHost(
              {
                mode: "full",
                databaseUrl: url.toString(),
                migrationsFolder: resolve("packages/db/drizzle/postgresql"),
                dataDirectory: directory,
                masterKey,
                redisUrl: process.env.AUTOFORGE_TEST_REDIS_URL!,
                minio: options,
              },
              (error) => errors.push(error),
            ),
          );
        await expect
          .poll(
            async () => (await repository.view({ batchId, jobId: job.id, limit: 10 }))!.job.status,
            { timeout: 60000, interval: 500 },
          )
          .toBe("completed");
        const view = (await repository.view({ batchId, jobId: job.id, limit: 10 }))!;
        expect(view.items).toHaveLength(4);
        expect(view.items.every((item) => item.conclusion?.includes("Full 合成初析"))).toBe(true);
        expect(view.groups).toHaveLength(strategy === "legacy" ? 1 : 2);
        expect(view.groups?.[0]?.memberCount).toBe(strategy === "legacy" ? 4 : 2);
        expect(view.groups?.[0]?.processed).toBe(strategy === "legacy" ? 4 : 2);
        expect(modelCalls).toBe(strategy === "legacy" ? 8 : 4);
        expect(peak).toBe(2);
        const progress = await redis.get(
          namespacedKey("ai-progress", DEFAULT_PROJECT_ID, 1, job.id),
        );
        if (strategy === "legacy") expect(progress).not.toBeNull();
        else {
          expect(view.items.every((item) => item.conclusion?.split("\n").length === 3)).toBe(true);
          expect(
            await repository.exportConclusions(
              batchId,
              view.items.map((item) => item.attemptId),
              new Date().toISOString(),
            ),
          ).toHaveLength(4);
        }
        expect(
          (await handle.pool.query("SELECT status FROM run_batches WHERE id=$1", [batchId])).rows[0]
            .status,
        ).toBe("failed");
        expect(errors).toEqual([]);
      } finally {
        await Promise.all(hosts.map((host) => host.close()));
        await queue.close();
        await nats.drain();
        redis.destroy();
        await new Promise<void>((resolveClose) => model.close(() => resolveClose()));
        for (const item of (await objects.list({ limit: 100 })).items)
          await objects.delete(item.objectKey);
        await client.removeBucket(options.bucket);
        await handle.close();
        await administration.query(`DROP DATABASE "${databaseName}"`);
        await administration.end();
        await rm(directory, { recursive: true, force: true });
      }
    },
    90000,
  );
});
