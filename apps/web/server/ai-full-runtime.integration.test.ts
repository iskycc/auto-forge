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
  PostgresLogDatabaseRepository,
  PostgresRoutedAttemptLogStore,
  createAttemptLogStore,
} from "@autoforge/db/postgres";
import { MinioObjectStore } from "@autoforge/object-store/minio";
import { JetStreamJobQueue } from "@autoforge/queue/jetstream";
import { PostgresOutboxRelay } from "@autoforge/queue/outbox";
import { namespacedKey } from "@autoforge/cache/memory";
import { builtInRoleDefinitions, DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { aiModelConfigurationSchema } from "@autoforge/contracts";
import { AiAnalysisWorkerHost } from "./ai-analysis-worker-host";
import { AI_EVIDENCE_INPUT_POLICY } from "@autoforge/application";
import { AesGcmSecretCipher } from "../src/lib/secret-cipher-core";

const enabled = [
  "AUTOFORGE_TEST_POSTGRES_URL",
  "AUTOFORGE_TEST_MINIO_ENDPOINT",
  "AUTOFORGE_TEST_MINIO_ACCESS_KEY",
  "AUTOFORGE_TEST_MINIO_SECRET_KEY",
  "AUTOFORGE_TEST_REDIS_URL",
  "AUTOFORGE_TEST_NATS_URL",
].every((key) => !!process.env[key]);
describe.skipIf(!enabled)("Full AI workers with real middleware", () => {
  it.each([
    { strategy: "legacy", databaseLogs: false, caseCount: 4, stackSize: 4, progressive: false },
    {
      strategy: "stack_groups_v2",
      databaseLogs: false,
      caseCount: 4,
      stackSize: 2,
      progressive: false,
    },
    {
      strategy: "stack_groups_v2",
      databaseLogs: true,
      caseCount: 4,
      stackSize: 2,
      progressive: false,
    },
    {
      strategy: "stack_groups_v2",
      databaseLogs: true,
      caseCount: 2,
      stackSize: 1,
      progressive: false,
    },
    {
      strategy: "stack_groups_v2",
      databaseLogs: true,
      caseCount: 19,
      stackSize: 10,
      progressive: false,
    },
    {
      strategy: "stack_groups_v2",
      databaseLogs: true,
      caseCount: 4,
      stackSize: 2,
      progressive: true,
    },
  ] as const)(
    "uses outbox/NATS and two workers ($strategy, daily logs=$databaseLogs, cases=$caseCount, stack size=$stackSize, progressive=$progressive)",
    async ({ strategy, databaseLogs, caseCount, stackSize, progressive }) => {
      const suffix = randomUUID().replaceAll("-", "");
      const now = new Date().toISOString();
      const databaseName = `ai_runtime_${suffix}`;
      const maintenanceDatabase = `ai_maintenance_${suffix}`;
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
      const modelEvidence: string[] = [];
      let releaseInitialPair: () => void = () => {};
      const initialPair = new Promise<void>((resolvePair) => {
        releaseInitialPair = resolvePair;
      });
      const model = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const read = body.messages.findLast((message: { role: string }) => message.role === "tool");
        modelEvidence.push(read.content);
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
                                reason: "Full 合成初析，待验证。".repeat(40),
                                evidence: "共同堆栈显示依赖连接异常。".repeat(40),
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
      const masterKey = randomBytes(32).toString("base64");
      const logRegistry = new PostgresLogDatabaseRepository(
        handle,
        new AesGcmSecretCipher(masterKey),
        createHash("sha256").update(masterKey).digest("hex"),
        resolve("packages/db/drizzle/log-postgresql"),
      );
      const logStore = new PostgresRoutedAttemptLogStore(
        logRegistry,
        createAttemptLogStore(resolve(directory, "legacy-logs")),
      );
      const logPrefix = `ai_read_${suffix.slice(0, 12)}`;
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
          `INSERT INTO run_batches(id,suite_id,suite_name,suite_version,status,retry_limit,environment_json,total_runs,project_id,created_at,updated_at) VALUES($1,'suite','Full AI test',1,'failed',0,'[]',$4,$2,$3,$3)`,
          [batchId, DEFAULT_PROJECT_ID, now, caseCount],
        );
        if (progressive)
          await handle.pool.query("UPDATE run_batches SET status='running' WHERE id=$1", [batchId]);
        for (let index = 0; index < caseCount; index++) {
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
          contextTokens: 200000,
          concurrency: 2,
          requestsPerMinute: 1000,
          tokensPerMinute: 10000000,
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
          progressive ? { followFinalResults: true } : undefined,
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
        if (databaseLogs) {
          await administration.query(`CREATE DATABASE "${maintenanceDatabase}"`);
          const connection = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
          await logRegistry.initializeDaily(
            {
              name: "AI actual daily logs",
              host: connection.hostname,
              port: Number(connection.port || 5432),
              username: decodeURIComponent(connection.username),
              password: decodeURIComponent(connection.password),
              maintenanceDatabase,
              databasePrefix: logPrefix,
              sslMode: "disable",
            },
            randomUUID(),
            now,
          );
          for (let index = 0; index < caseCount; index++)
            await logStore.appendChunks({
              batchId,
              attemptId: `attempt-${index}-${suffix}`,
              receivedAt: now,
              chunks: [
                ...Array.from({ length: 25 }, (_, sequence) => ({
                  stream: "stdout" as const,
                  sequence,
                  recordedAt: now,
                  content:
                    (sequence === 16 ? "1m" : "") +
                    `实际日志 member=${index} page=${sequence}\n` +
                    (sequence === 0
                      ? "password=full-business-password\n全文开始标识\n" +
                        "普通业务日志\n".repeat(1000)
                      : "") +
                    (sequence === 24
                      ? `java.lang.AssertionError: expected ${Math.floor(index / stackSize)}\n\tat example.Test.run(Test.java:20)\n\nTestNG exit code:1\n`
                      : "业务正文\n") +
                    (sequence === 15 ? "\u001b[3" : sequence === 16 ? "\u001b[0m" : ""),
                })),
                ...(["stderr", "agent"] as const).map((stream) => ({
                  stream,
                  sequence: 0,
                  recordedAt: now,
                  content: `EXCLUDED_${stream}_SENTINEL`,
                })),
              ],
            });
        }
        if (!databaseLogs) {
          const evidenceWorks = [];
          for (let index = 0; index < caseCount; index++)
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
              inputPolicy: AI_EVIDENCE_INPUT_POLICY,
              stdoutComplete: true,
              executionRunId: work.executionRunId,
              attemptId: work.attemptId,
              signature:
                strategy === "legacy"
                  ? "same-stack-fixture"
                  : `exact-stack-bundle-v1:fixture-${Math.floor(index / stackSize)}`,
              limitations: [],
              stackParts: [{ id: `part-${index}`, objectKey: partKey, sizeBytes: 100 }],
              parts: [{ id: `part-${index}`, objectKey: partKey, sizeBytes: 100 }],
            });
            await repository.saveEvidence(
              work,
              manifestKey,
              strategy === "legacy"
                ? "same-stack-fixture"
                : `exact-stack-bundle-v1:fixture-${Math.floor(index / stackSize)}`,
              now,
            );
          }
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
        if (progressive) {
          await expect
            .poll(async () => (await repository.view({ batchId, jobId: job.id, limit: 50 }))!.job, {
              timeout: 60000,
              interval: 500,
            })
            .toMatchObject({ total: caseCount, completed: caseCount, acceptingFinalResults: true });
          expect(
            (await handle.pool.query("SELECT status FROM run_batches WHERE id=$1", [batchId]))
              .rows[0]!.status,
          ).toBe("running");
          await handle.pool.query("UPDATE run_batches SET status='failed' WHERE id=$1", [batchId]);
          hosts.forEach((host) => host.wake());
        }
        await expect
          .poll(
            async () => (await repository.view({ batchId, jobId: job.id, limit: 50 }))!.job.status,
            { timeout: 60000, interval: 500 },
          )
          .toMatch(/^(completed|partial|failed)$/u);
        const view = (await repository.view({ batchId, jobId: job.id, limit: 50 }))!;
        expect(view.job.status, JSON.stringify(view)).toBe("completed");
        expect(view.items).toHaveLength(caseCount);
        expect(view.items.every((item) => item.conclusion?.includes("Full 合成初析"))).toBe(true);
        const groupSizes = Array.from({ length: Math.ceil(caseCount / stackSize) }, (_, index) =>
          Math.min(stackSize, caseCount - index * stackSize),
        );
        expect(view.groups?.map((group) => group.memberCount).sort((a, b) => a - b)).toEqual(
          [...groupSizes].sort((a, b) => a - b),
        );
        expect(view.groups?.every((group) => group.processed === group.memberCount)).toBe(true);
        // A small member contributes one input part and its cleaned, combined stdout.
        const expectedCalls = databaseLogs
          ? groupSizes.reduce((sum, size) => sum + (size < 10 ? size * 2 : 1), 0)
          : strategy === "legacy"
            ? caseCount * 2
            : caseCount;
        expect(modelCalls).toBe(expectedCalls);
        if (databaseLogs) {
          const delivered = modelEvidence.join("\n");
          for (let member = 0; member < caseCount; member++) {
            const groupSize = groupSizes[Math.floor(member / stackSize)]!;
            for (let sequence = 0; sequence < 25; sequence++)
              if (groupSize < 10)
                expect(delivered).toContain(`实际日志 member=${member} page=${sequence}\\n`);
              else expect(delivered).not.toContain(`实际日志 member=${member} page=${sequence}\\n`);
          }
          for (let group = 0; group < groupSizes.length; group++)
            expect(delivered).toContain(`java.lang.AssertionError: expected ${group}`);
          expect(delivered).not.toContain("EXCLUDED_");
          expect(delivered).not.toContain("TestNG exit code:1");
          expect(delivered).toContain("全文开始标识");
          expect(delivered).toContain("password=full-business-password");
          expect(delivered).not.toMatch(/\\u001b|\u001b/u);
          const original = await logStore.listChunks({
            batchId,
            attemptId: `attempt-0-${suffix}`,
            stream: "stdout",
            afterSequence: 14,
            limit: 2,
          });
          expect(original.items[0]?.content).toContain("\u001b[3");
          expect(original.items[1]?.content).toContain("\u001b[0m");
          expect(
            view.items.every((item) => item.signature?.startsWith("exact-stack-bundle-v2:")),
          ).toBe(true);
        }
        expect(peak).toBe(2);
        const progress = await redis.get(
          namespacedKey("ai-progress", DEFAULT_PROJECT_ID, 1, job.id),
        );
        if (strategy === "legacy") expect(progress).not.toBeNull();
        else {
          expect(view.items.every((item) => item.conclusion?.split("\n").length === 3)).toBe(true);
          for (const item of view.items) assertBoundedConclusion(item.conclusion);
          expect(
            await repository.exportConclusions(
              batchId,
              view.items.map((item) => item.attemptId),
              new Date().toISOString(),
            ),
          ).toHaveLength(caseCount);
        }
        if (databaseLogs && caseCount === 4) {
          const firstSingleCall = modelEvidence.length;
          const singleNow = new Date().toISOString();
          const single = await repository.create(
            {
              ...job,
              id: randomUUID(),
              strategy: "single_full_v2",
              attemptId: `attempt-0-${suffix}`,
              status: "queued",
              createdAt: singleNow,
              updatedAt: singleNow,
              total: 0,
              prepared: 0,
              completed: 0,
              failed: 0,
              reason: null,
              revision: 1,
            },
            "single-after-batch",
          );
          hosts.forEach((host) => host.wake());
          await expect
            .poll(
              async () =>
                (await repository.view({ batchId, jobId: single.id, limit: 10 }))!.job.status,
              { timeout: 30000, interval: 250 },
            )
            .toMatch(/^(completed|partial|failed)$/u);
          const singleView = (await repository.view({ batchId, jobId: single.id, limit: 10 }))!;
          expect(singleView.job.status, JSON.stringify(singleView)).toBe("completed");
          expect(singleView.items).toHaveLength(1);
          expect(singleView.items[0]?.attemptId).toBe(`attempt-0-${suffix}`);
          expect(singleView.items[0]?.conclusion).toContain("Full 合成初析");
          assertBoundedConclusion(singleView.items[0]?.conclusion);
          expect(modelCalls - firstSingleCall).toBe(2);
          const delivered = modelEvidence.slice(firstSingleCall).join("\n");
          for (let sequence = 0; sequence < 25; sequence++)
            expect(delivered).toContain(`实际日志 member=0 page=${sequence}\\n`);
          expect(delivered).not.toMatch(/实际日志 member=[123] |EXCLUDED_/u);
          expect((await repository.view({ batchId, jobId: job.id, limit: 50 }))!.job.status).toBe(
            "completed",
          );
        }
        expect(
          (await handle.pool.query("SELECT status FROM run_batches WHERE id=$1", [batchId])).rows[0]
            .status,
        ).toBe("failed");
        expect(errors).toEqual([]);
      } finally {
        await Promise.all(hosts.map((host) => host.close()));
        await logStore.close();
        await logRegistry.close();
        await queue.close();
        await nats.drain();
        redis.destroy();
        await new Promise<void>((resolveClose) => model.close(() => resolveClose()));
        let objectCursor: string | undefined;
        do {
          const page = await objects.list({
            limit: 100,
            ...(objectCursor ? { cursor: objectCursor } : {}),
          });
          for (const item of page.items) await objects.delete(item.objectKey);
          objectCursor = page.nextCursor;
        } while (objectCursor);
        await client.removeBucket(options.bucket);
        await handle.close();
        await administration.query(`DROP DATABASE "${databaseName}"`);
        const daily = await administration.query<{ datname: string }>(
          "SELECT datname FROM pg_database WHERE starts_with(datname,$1)",
          [logPrefix + "_"],
        );
        for (const row of daily.rows) await administration.query(`DROP DATABASE "${row.datname}"`);
        await administration.query(`DROP DATABASE IF EXISTS "${maintenanceDatabase}"`);
        await administration.end();
        await rm(directory, { recursive: true, force: true });
      }
    },
    90000,
  );
});

function assertBoundedConclusion(conclusion: string | null | undefined): void {
  const lines = conclusion?.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines![1]!.length).toBeLessThanOrEqual(3 + 160);
  expect(lines![2]!.length).toBeLessThanOrEqual(3 + 200);
  expect(lines![1]).toMatch(/…$/u);
  expect(lines![2]).toMatch(/…$/u);
}
