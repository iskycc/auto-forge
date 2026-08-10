import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  CaseSourceService,
  CaseSuiteService,
  ExecutionControlService,
  ExecutionEnvironmentService,
  ExecutionSecretService,
  ImportTestNgJarService,
  IdentityAccessService,
  JobWorker,
  RunBatchSchedulingService,
  RunnerControlService,
  type CaseCatalogRepository,
  type CaseSuiteRepository,
  type JarObjectStorePort,
  type IdentityAccessRepository,
  type ExecutionControlRepository,
  type ExecutionEnvironmentRepository,
  type ExecutionSecretRepository,
  type CachePort,
  type JobQueuePort,
  type RunBatchRepository,
  type RunnerRepository,
} from "@autoforge/application";
import { MemoryCache } from "@autoforge/cache/memory";
import {
  createSqliteDatabase,
  SqliteCaseCatalogRepository,
  SqliteCaseSuiteRepository,
  SqliteExecutionControlRepository,
  SqliteExecutionEnvironmentRepository,
  SqliteExecutionSecretRepository,
  SqliteIdentityAccessRepository,
  SqliteRunBatchRepository,
  SqliteRunnerRepository,
} from "@autoforge/db/sqlite";
import { LocalObjectStore } from "@autoforge/object-store/local";
import { SqliteJobQueue } from "@autoforge/queue/sqlite";
import { TestNgJarDiscovery } from "@autoforge/testng-discovery";
import { RunnerProtocolController } from "@autoforge/runner-sdk";
import { uuidV7 } from "@autoforge/ids";

import { loadAppConfig } from "./config";
import { LdapDirectory } from "./ldap-directory";
import { ScryptPasswordHasher } from "./password-hasher";
import { MemoryRequestLimiter, RedisRequestLimiter, type RequestLimiter } from "./request-limiter";
import { AesGcmSecretCipher } from "./secret-cipher";

export type PlatformServices = Awaited<ReturnType<typeof createPlatformServices>>;

type RuntimeInfrastructure = {
  ready(): Promise<void>;
  close(): Promise<void>;
};

async function createPlatformServices() {
  const config = loadAppConfig();
  let catalog: CaseCatalogRepository;
  let suites: CaseSuiteRepository;
  let runners: RunnerRepository;
  let identities: IdentityAccessRepository;
  let executions: ExecutionControlRepository;
  let environments: ExecutionEnvironmentRepository;
  let secrets: ExecutionSecretRepository;
  let batches: RunBatchRepository;
  let objectStore: JarObjectStorePort;
  let jobQueue: JobQueuePort;
  let cache: CachePort;
  let closeDatabase: () => Promise<void>;
  let runnerRequestLimiter: RequestLimiter = new MemoryRequestLimiter();
  let infrastructure: RuntimeInfrastructure | undefined;
  if (config.mode === "lite") {
    const database = createSqliteDatabase({
      databasePath: config.databasePath,
      migrationsFolder: config.migrationsFolder,
    });
    catalog = new SqliteCaseCatalogRepository(database);
    suites = new SqliteCaseSuiteRepository(database);
    runners = new SqliteRunnerRepository(database);
    identities = new SqliteIdentityAccessRepository(database);
    executions = new SqliteExecutionControlRepository(database);
    environments = new SqliteExecutionEnvironmentRepository(database);
    secrets = new SqliteExecutionSecretRepository(database);
    batches = new SqliteRunBatchRepository(database);
    objectStore = new LocalObjectStore(config.dataDirectory);
    jobQueue = new SqliteJobQueue(database);
    cache = new MemoryCache();
    closeDatabase = async () => database.close();
  } else {
    const [
      {
        createPostgresDatabase,
        PostgresCaseCatalogRepository,
        PostgresCaseSuiteRepository,
        PostgresIdentityAccessRepository,
        PostgresExecutionControlRepository,
        PostgresExecutionEnvironmentRepository,
        PostgresExecutionSecretRepository,
        PostgresRunBatchRepository,
        PostgresRunnerRepository,
      },
      { MinioObjectStore },
      { JetStreamJobQueue },
      { RedisCache },
      { connect },
      { createClient },
    ] = await Promise.all([
      import("@autoforge/db/postgres"),
      import("@autoforge/object-store/minio"),
      import("@autoforge/queue/jetstream"),
      import("@autoforge/cache/redis"),
      import("nats"),
      import("redis"),
    ]);
    const database = createPostgresDatabase({
      connectionString: config.databaseUrl,
      migrationsFolder: config.migrationsFolder,
    });
    try {
      await database.ready;
      const nats = await connect({
        servers: config.natsServers,
        timeout: 5_000,
        reconnect: false,
      });
      const jetStreamManager = await nats.jetstreamManager().catch(async (error: unknown) => {
        await nats.close();
        throw error;
      });
      jobQueue = await JetStreamJobQueue.create(nats.jetstream(), jetStreamManager);
      const redis = createClient({
        url: config.redisUrl,
        socket: {
          connectTimeout: 5_000,
          reconnectStrategy: false,
        },
      });
      redis.on("error", () => {
        // Connection failures are surfaced by connect(), ping(), or readiness checks.
      });
      await redis.connect().catch(async (error: unknown) => {
        await Promise.allSettled([nats.close(), redis.close()]);
        throw error;
      });
      cache = new RedisCache(redis);
      closeDatabase = () => database.close();
      runnerRequestLimiter = new RedisRequestLimiter((script, options) =>
        redis.eval(script, options),
      );
      infrastructure = {
        ready: async () => {
          await Promise.all([jobQueue.ready(), redis.ping()]);
        },
        close: async () => {
          await Promise.allSettled([
            jobQueue.close(),
            cache.close(),
            nats.drain(),
            redis.close(),
            closeDatabase(),
          ]);
        },
      };
    } catch (error) {
      await database.close();
      throw new Error("无法初始化 Full 模式基础设施。", { cause: error });
    }
    catalog = new PostgresCaseCatalogRepository(database);
    suites = new PostgresCaseSuiteRepository(database);
    runners = new PostgresRunnerRepository(database);
    identities = new PostgresIdentityAccessRepository(database);
    executions = new PostgresExecutionControlRepository(database);
    environments = new PostgresExecutionEnvironmentRepository(database);
    secrets = new PostgresExecutionSecretRepository(database);
    batches = new PostgresRunBatchRepository(database);
    objectStore = new MinioObjectStore(config.minio);
  }
  const discovery = new TestNgJarDiscovery({ maxJarBytes: config.maxJarBytes });
  const clock = { now: () => new Date() };
  const ids = { next: () => uuidV7() };
  const importTestNgJar = new ImportTestNgJarService({
    discovery,
    objectStore,
    catalog,
    clock,
    ids,
  });
  const caseSources = new CaseSourceService(catalog, objectStore);
  const caseSuites = new CaseSuiteService(suites, catalog, clock, ids);
  const runnerCredentials = {
    issue: () => randomBytes(32).toString("base64url"),
    hash: (value: string) => createHash("sha256").update(value).digest("hex"),
    verifyBootstrapToken: (value: string) => secureEqual(value, config.runnerBootstrapToken ?? ""),
  };
  const runnerControl = new RunnerControlService(runners, runnerCredentials, clock, ids);
  const runBatches = new RunBatchSchedulingService(
    batches,
    suites,
    runners,
    clock,
    ids,
    {
      maximumCpuUtilizationPercent: config.scheduler.maximumCpuUtilizationPercent,
      maximumMemoryUtilizationPercent: config.scheduler.maximumMemoryUtilizationPercent,
      maximumLoadPerCpu: config.scheduler.maximumLoadPerCpu,
    },
    config.scheduler.metricsMaximumAgeSeconds,
    environments,
    { catalog, objectStore },
  );
  if (config.mode === "lite") {
    const workerAbort = new AbortController();
    let workerFailure: unknown;
    const worker = new JobWorker(
      jobQueue,
      {
        "dispatch-run": async (job) => {
          const batchId = job.payload.batchId;
          if (typeof batchId !== "string") throw new Error("Dispatch job batchId is invalid.");
          await runBatches.schedule(batchId);
        },
      },
      clock,
      {
        workerId: `lite-web-${process.pid}`,
        concurrency: 4,
        leaseDurationMs: 30_000,
        minimumPollMs: 100,
        maximumPollMs: 2_000,
      },
      workerLogger,
    );
    const workerRun = worker.run(workerAbort.signal).catch((error: unknown) => {
      workerFailure = error;
      workerLogger.error("embedded worker stopped unexpectedly", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    });
    infrastructure = {
      ready: async () => {
        await jobQueue.ready();
        if (workerFailure) {
          throw new Error("Lite embedded worker is not running.", { cause: workerFailure });
        }
      },
      close: async () => {
        workerAbort.abort();
        await workerRun;
        await Promise.allSettled([jobQueue.close(), cache.close(), closeDatabase()]);
      },
    };
  }
  if (!infrastructure) throw new Error("Runtime infrastructure was not initialized.");
  globalServices.__autoforgeClosePlatformServices = infrastructure.close;
  const secretCipher = new AesGcmSecretCipher(config.masterKey);
  const identityAccess = new IdentityAccessService(
    identities,
    new ScryptPasswordHasher(),
    {
      issue: () => randomBytes(32).toString("base64url"),
      hash: (value) => createHash("sha256").update(value).digest("hex"),
      verifyBootstrapToken: (value) => secureEqual(value, config.adminBootstrapToken ?? ""),
    },
    secretCipher,
    new LdapDirectory(),
    clock,
    ids,
    config.sessionTtlHours,
  );
  await identityAccess.initialize();
  const executionEnvironments = new ExecutionEnvironmentService(environments, clock, ids);
  const executionSecrets = new ExecutionSecretService(secrets, secretCipher, clock, ids);
  globalServices.__autoforgeRecordTerminalAudit = (event) =>
    identityAccess.recordTerminalLifecycle(event);
  const executionControl = new ExecutionControlService(
    executions,
    runners,
    runnerCredentials,
    secretCipher,
    objectStore,
    clock,
    ids,
  );
  const runnerProtocol = new RunnerProtocolController(executionControl);

  return {
    config,
    catalog,
    discovery,
    objectStore,
    importTestNgJar,
    caseSources,
    suites,
    caseSuites,
    runners,
    identities,
    executions,
    environments,
    executionEnvironments,
    secrets,
    executionSecrets,
    identityAccess,
    runnerControl,
    executionControl,
    runnerProtocol,
    runBatches,
    runnerRequestLimiter,
    jobQueue,
    cache,
    infrastructure,
  };
}

const workerLogger = {
  info(message: string, details: Record<string, unknown> = {}) {
    writeWorkerLog("info", message, details);
  },
  error(message: string, details: Record<string, unknown> = {}) {
    writeWorkerLog("error", message, details);
  },
};

function writeWorkerLog(
  level: "info" | "error",
  message: string,
  details: Record<string, unknown>,
): void {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...details });
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

function secureEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

const globalServices = globalThis as typeof globalThis & {
  __autoforgePlatformServices?: Promise<PlatformServices>;
  __autoforgeClosePlatformServices?: () => Promise<void>;
  __autoforgeRecordTerminalAudit?: (event: {
    actorId: string;
    runnerId: string;
    sessionId: string;
    action: "terminal.session_started" | "terminal.session_finished";
    reason?: string;
    inputMessages?: number;
    inputBytes?: number;
    outputBytes?: number;
  }) => Promise<void>;
};

export function getPlatformServices(): Promise<PlatformServices> {
  globalServices.__autoforgePlatformServices ??= createPlatformServices();
  return globalServices.__autoforgePlatformServices;
}
