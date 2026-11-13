import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { uuidV7 } from "@autoforge/ids";
import { aiThreadConfigurationSchema } from "./ai-analysis-configuration";
import {
  AiAnalysisWorker,
  AiAnalysisService,
  resolveAutomaticAiAuthority,
  type AiAnalysisRepository,
  type CachePort,
} from "@autoforge/application";
import { AesGcmSecretCipher } from "../src/lib/secret-cipher-core";
import { AiEvidenceStore } from "./ai-evidence";
import { OpenAiCompatibleGateway } from "./ai-model-gateway";
import { isDomainError } from "@autoforge/domain";
import { awaitRedisReply, redisRuntimeCommandOptions } from "../src/lib/resilient-connections";

const configuration = aiThreadConfigurationSchema.parse(workerData);
const priority = new Int32Array(configuration.prioritySignal);
const shutdown = new AbortController();
const report = (error: unknown) =>
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : "AI background operation failed.",
  });
let wake: (() => void) | undefined;
parentPort?.on("message", (message) => {
  if (message === "stop") shutdown.abort();
  wake?.();
});
const resources = await initialize();
const cipher = new AesGcmSecretCipher(configuration.masterKey);
const clock = { now: () => new Date() };
const ids = { next: uuidV7 };
const canWork = () => Atomics.load(priority, 0) === 0 && !shutdown.signal.aborted;
const service = new AiAnalysisService(resources.repository, resources.batches, cipher, clock, ids);
const worker = new AiAnalysisWorker(
  resources.repository,
  new AiEvidenceStore(
    resources.repository,
    resources.logs,
    resources.objects,
    configuration.masterKey,
    canWork,
    resources.isBusy,
  ),
  new OpenAiCompatibleGateway(),
  resources.identities,
  cipher,
  clock,
  ids,
  canWork,
  report,
  resources.cache,
  resources.isBusy,
);
let automaticAfter: string | null = null;
let nextAutomaticAt = 0;
try {
  while (!shutdown.signal.aborted) {
    let worked = false;
    try {
      if (canWork()) {
        worked = await worker.tick(shutdown.signal);
        if (
          Date.now() >= nextAutomaticAt &&
          (await resources.repository.configuration()).configuration?.enabled
        ) {
          nextAutomaticAt = Date.now() + 15000;
          const candidates = await resources.repository.automaticCandidates(automaticAfter, 20);
          for (const candidate of candidates) {
            automaticAfter = candidate.batchId;
            const authority = await resolveAutomaticAiAuthority(
              resources.identities,
              resources.batches,
              candidate.batchId,
              candidate.requestedByUsername,
            );
            if (!authority.actor) {
              await recordSkipped(candidate, authority.unavailableReason);
              continue;
            }
            try {
              await service.createAutomatic(authority.actor, candidate.batchId);
            } catch (error) {
              if (isDomainError(error) && error.code === "AUTH_FORBIDDEN")
                await recordSkipped(
                  candidate,
                  `自动初析未发起：${authority.actorLabel}缺少当前 AI 或证据权限。`,
                );
              else report(error);
            }
          }
          if (candidates.length < 20) automaticAfter = null;
        }
      }
    } catch (error) {
      if (!shutdown.signal.aborted) report(error);
    }
    if (!shutdown.signal.aborted)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, worked ? 100 : 2000);
        function finish() {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }
        wake = finish;
      });
  }
} finally {
  await resources.close();
  parentPort?.close();
}

async function recordSkipped(candidate: { batchId: string; projectId: string }, reason: string) {
  const now = clock.now().toISOString();
  await resources.repository.create(
    {
      id: ids.next(),
      batchId: candidate.batchId,
      projectId: candidate.projectId,
      attemptId: null,
      requestedBy: "automatic-skipped",
      status: "failed",
      createdAt: now,
      updatedAt: now,
      total: 0,
      prepared: 0,
      completed: 0,
      failed: 0,
      reason,
      revision: 1,
    },
    "automatic",
  );
}

async function initialize() {
  if (configuration.mode === "lite") {
    const db = await import("@autoforge/db/sqlite");
    const { LocalObjectStore } = await import("@autoforge/object-store/local");
    const handle = db.createSqliteDatabase({
      databasePath: configuration.databasePath,
      migrationsFolder: configuration.migrationsFolder,
      busyTimeoutMs: 15,
    });
    const objects = new LocalObjectStore(configuration.dataDirectory);
    const archives = new db.SqliteLogArchiveRepository(handle);
    const local = db.createAttemptLogStore(join(configuration.dataDirectory, "attempt-logs"));
    const logs = new db.ArchivedAttemptLogStore(local, archives, objects);
    return {
      repository: new db.SqliteAiAnalysisRepository(handle) as AiAnalysisRepository,
      batches: new db.SqliteRunBatchRepository(handle),
      identities: new db.SqliteIdentityAccessRepository(handle),
      logs: new db.SqliteExecutionControlRepository(handle, local, logs),
      objects,
      cache: undefined as CachePort | undefined,
      isBusy: db.isDatabaseLockContentionError,
      close: async () => {
        await logs.close();
        handle.close();
      },
    };
  }
  const db = await import("@autoforge/db/postgres");
  const { MinioObjectStore } = await import("@autoforge/object-store/minio");
  const { RedisCache } = await import("@autoforge/cache/redis");
  const { createClient } = await import("redis");
  const handle = db.createPostgresDatabase({
    connectionString: configuration.databaseUrl,
    migrationsFolder: configuration.migrationsFolder,
    poolMax: 1,
    statementTimeoutMs: 2000,
    lockTimeoutMs: 50,
  });
  await handle.ready;
  const { port, ...minio } = configuration.minio;
  const objects = new MinioObjectStore({ ...minio, ...(port !== undefined ? { port } : {}) });
  const registry = new db.PostgresLogDatabaseRepository(
    handle,
    new AesGcmSecretCipher(configuration.masterKey),
    db.logStoragePlatformId(configuration.masterKey),
    join(configuration.migrationsFolder, "../log-postgresql"),
  );
  const routed = new db.PostgresRoutedAttemptLogStore(
    registry,
    db.readOnlyLegacyAttemptLogs(
      db.createAttemptLogStore(join(configuration.dataDirectory, "attempt-logs")),
    ),
  );
  const logs = new db.ArchivedAttemptLogStore(
    routed,
    new db.PostgresLogArchiveRepository(handle),
    objects,
  );
  const redis = createClient({
    url: configuration.redisUrl,
    socket: { connectTimeout: 1000, reconnectStrategy: false },
    ...redisRuntimeCommandOptions,
  });
  redis.on("error", (error) => report(error));
  let cache: CachePort | undefined;
  try {
    await redis.connect();
    cache = new RedisCache({
      get: (key) => awaitRedisReply(redis.get(key)),
      set: (key, value, options) => awaitRedisReply(redis.set(key, value, options)),
      del: (key) => awaitRedisReply(redis.del(key)),
    });
  } catch (error) {
    report(error);
  }
  return {
    repository: new db.PostgresAiAnalysisRepository(handle) as AiAnalysisRepository,
    batches: new db.PostgresRunBatchRepository(handle),
    identities: new db.PostgresIdentityAccessRepository(handle),
    logs: new db.PostgresExecutionControlRepository(handle, logs),
    objects,
    cache,
    isBusy: db.isDatabaseLockContentionError,
    close: async () => {
      if (redis.isOpen) redis.destroy();
      await logs.close();
      await handle.close();
    },
  };
}
