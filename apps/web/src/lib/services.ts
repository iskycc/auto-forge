import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import {
  CaseDefinitionService,
  CaseSourceService,
  CaseSuiteService,
  ExecutionControlService,
  ExecutionEnvironmentService,
  ExecutionSecretService,
  ImportTestNgJarService,
  IdentityAccessService,
  JobWorker,
  PublicPlatformStatisticsService,
  PlatformOperationsService,
  ProjectStructureService,
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
  type PlatformStatisticsRepository,
  type PlatformOperationsRepository,
  type ProjectStructureRepository,
} from "@autoforge/application";
import { MemoryCache } from "@autoforge/cache/memory";
import {
  createAttemptLogStore,
  createSqliteDatabase,
  SqliteCaseCatalogRepository,
  SqliteCaseSuiteRepository,
  SqliteExecutionControlRepository,
  SqliteExecutionEnvironmentRepository,
  SqliteExecutionSecretRepository,
  SqliteIdentityAccessRepository,
  SqliteRunBatchRepository,
  SqliteRunnerRepository,
  SqlitePlatformStatisticsRepository,
  SqlitePlatformOperationsRepository,
  SqliteProjectStructureRepository,
} from "@autoforge/db/sqlite";
import { LocalObjectStore } from "@autoforge/object-store/local";
import { SqliteJobQueue } from "@autoforge/queue/sqlite";
import { TestNgJarDiscovery } from "@autoforge/testng-discovery";
import { RunnerProtocolController } from "@autoforge/runner-sdk";
import { uuidV7 } from "@autoforge/ids";

import { appConfigurationStore, loadAppConfig } from "./config";
import { LdapDirectory } from "./ldap-directory";
import { ScryptPasswordHasher } from "./password-hasher";
import { MemoryRequestLimiter, RedisRequestLimiter, type RequestLimiter } from "./request-limiter";
import { natsReconnectOptions, redisReconnectDelay } from "./resilient-connections";
import { RunnerAgentInstaller } from "./runner-agent-installer";
import { RunnerAgentResourceStore } from "./runner-agent-resources";
import { issueRunnerBootstrapToken, verifyRunnerBootstrapToken } from "./runner-bootstrap-token";
import { AesGcmSecretCipher } from "./secret-cipher";

export type PlatformServices = Awaited<ReturnType<typeof createPlatformServices>>;

type RuntimeInfrastructure = {
  ready(): Promise<void>;
  close(): Promise<void>;
};

async function createPlatformServices() {
  const config = loadAppConfig();
  const configurationStore = appConfigurationStore(config);
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
  let statisticsRepository: PlatformStatisticsRepository;
  let operationsRepository: PlatformOperationsRepository;
  let projectStructuresRepository: ProjectStructureRepository;
  let closeDatabase: () => Promise<void>;
  let runnerRequestLimiter: RequestLimiter = new MemoryRequestLimiter();
  let infrastructure: RuntimeInfrastructure | undefined;
  if (config.mode === "lite") {
    const database = createSqliteDatabase({
      databasePath: config.databasePath,
      migrationsFolder: config.migrationsFolder,
    });
    const attemptLogs = createAttemptLogStore(join(config.dataDirectory, "attempt-logs"));
    catalog = new SqliteCaseCatalogRepository(database);
    suites = new SqliteCaseSuiteRepository(database);
    runners = new SqliteRunnerRepository(database);
    identities = new SqliteIdentityAccessRepository(database);
    executions = new SqliteExecutionControlRepository(database, attemptLogs);
    environments = new SqliteExecutionEnvironmentRepository(database);
    secrets = new SqliteExecutionSecretRepository(database);
    batches = new SqliteRunBatchRepository(database);
    objectStore = new LocalObjectStore(config.dataDirectory);
    jobQueue = new SqliteJobQueue(database);
    cache = new MemoryCache();
    statisticsRepository = new SqlitePlatformStatisticsRepository(database);
    operationsRepository = new SqlitePlatformOperationsRepository(database, attemptLogs);
    projectStructuresRepository = new SqliteProjectStructureRepository(database);
    closeDatabase = async () => {
      attemptLogs.close();
      database.close();
    };
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
        PostgresPlatformStatisticsRepository,
        PostgresPlatformOperationsRepository,
        PostgresProjectStructureRepository,
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
    const attemptLogs = createAttemptLogStore(join(config.dataDirectory, "attempt-logs"));
    const database = createPostgresDatabase({
      connectionString: config.databaseUrl,
      migrationsFolder: config.migrationsFolder,
    });
    try {
      await database.ready;
      const nats = await connect({
        servers: config.natsServers,
        timeout: 5_000,
        ...natsReconnectOptions,
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
          reconnectStrategy: redisReconnectDelay,
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
      closeDatabase = () => {
        attemptLogs.close();
        return database.close();
      };
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
    executions = new PostgresExecutionControlRepository(database, attemptLogs);
    environments = new PostgresExecutionEnvironmentRepository(database);
    secrets = new PostgresExecutionSecretRepository(database);
    batches = new PostgresRunBatchRepository(database);
    objectStore = new MinioObjectStore(config.minio);
    statisticsRepository = new PostgresPlatformStatisticsRepository(database);
    operationsRepository = new PostgresPlatformOperationsRepository(database, attemptLogs);
    projectStructuresRepository = new PostgresProjectStructureRepository(database);
  }
  const discovery = new TestNgJarDiscovery({
    maxJarBytes: config.maxJarBytes,
    targetJavaVersion: config.testNgTargetJavaVersion,
  });
  const clock = { now: () => new Date() };
  const ids = { next: () => uuidV7() };
  const importTestNgJar = new ImportTestNgJarService({
    discovery,
    objectStore,
    catalog,
    clock,
    ids,
  });
  const caseSources = new CaseSourceService(catalog, objectStore, clock, ids, jobQueue, discovery);
  const caseSuites = new CaseSuiteService(suites, catalog, clock, ids);
  const caseDefinitions = new CaseDefinitionService(catalog, clock, ids);
  const projectStructures = new ProjectStructureService(
    projectStructuresRepository,
    objectStore,
    clock,
    ids,
  );
  const runnerCredentials = {
    issue: () => randomBytes(32).toString("base64url"),
    issueBootstrapToken: () => issueRunnerBootstrapToken(config.masterKey, clock.now()),
    hash: (value: string) => createHash("sha256").update(value).digest("hex"),
    verifyBootstrapToken: (value: string) =>
      secureEqual(value, config.runnerBootstrapToken ?? "") ||
      verifyRunnerBootstrapToken(value, config.masterKey, clock.now()),
  };
  const runnerControl = new RunnerControlService(
    runners,
    runnerCredentials,
    executions,
    clock,
    ids,
    batches,
  );
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
    config.scheduler.projectMaximumConcurrency,
    config.scheduler.priorityAgingIntervalMinutes,
    projectStructuresRepository,
  );
  const platformOperations = new PlatformOperationsService(
    operationsRepository,
    clock,
    ids,
    {
      issue: () => `af_api_${randomBytes(32).toString("base64url")}`,
      hash: (value) => createHash("sha256").update(value).digest("hex"),
    },
    objectStore,
    batches,
  );
  await platformOperations.initialize();
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
        "object-cleanup": caseSources.objectCleanupHandler(),
        "jar-import": importTestNgJar.jobHandler(),
        "analytics-export": platformOperations.analyticsExportJobHandler(),
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
    batches,
  );
  const runnerProtocol = new RunnerProtocolController(executionControl);
  const publicStatistics = new PublicPlatformStatisticsService(
    statisticsRepository,
    clock,
    60_000,
    config.publicDashboardRefreshSeconds,
  );
  const scheduleAbort = new AbortController();
  const scheduleLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 30_000, async () => {
          await platformOperations.triggerDueSchedules(async (schedule) => {
            const candidates = (await runners.list(offlineCutoff(clock.now()), 500)).filter(
              (runner) => runner.state === "online",
            );
            if (candidates.length === 0) {
              throw new Error("No online Runner is available for schedule.");
            }
            const batch = await runBatches.create({
              projectId: schedule.projectId,
              suiteId: schedule.suiteId,
              runnerIds: candidates.map((runner) => runner.id),
              environmentVariables: [],
            });
            return batch.id;
          });
          await platformOperations.generateNotifications();
          await operationsRepository.rebuildAnalyticsFacts(1_000);
        })
      : Promise.resolve();
  const retentionLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 3_600_000, async () => {
          await platformOperations.runRetentionCycle();
        })
      : Promise.resolve();
  const ldapSynchronizationLoop = runPeriodic(scheduleAbort.signal, 60_000, async () => {
    const ldap = await identities.getLdapConfiguration();
    if (!ldap?.enabled || ldap.synchronizationIntervalMinutes <= 0) return;
    await platformOperations.runDueLdapSynchronization(ldap.synchronizationIntervalMinutes, () =>
      identityAccess.synchronizeLdapAsSystem(),
    );
  });
  const runtimeInfrastructure = infrastructure;
  infrastructure = {
    ready: () => runtimeInfrastructure.ready(),
    close: async () => {
      scheduleAbort.abort();
      await Promise.all([scheduleLoop, retentionLoop, ldapSynchronizationLoop]);
      await runtimeInfrastructure.close();
    },
  };
  globalServices.__autoforgeClosePlatformServices = infrastructure.close;
  const runnerAgentResources = new RunnerAgentResourceStore(
    join(config.workspaceRoot, "resources", "agents"),
  );
  const runnerAgentInstaller = new RunnerAgentInstaller({
    resources: runnerAgentResources,
    controlPlaneUrl: config.web.publicBaseUrl,
    issueBootstrapToken: () => runnerControl.issueBootstrapToken(),
  });

  return {
    config,
    configurationStore,
    catalog,
    discovery,
    objectStore,
    importTestNgJar,
    caseSources,
    suites,
    caseSuites,
    caseDefinitions,
    projectStructures,
    runners,
    identities,
    executions,
    environments,
    executionEnvironments,
    secrets,
    executionSecrets,
    identityAccess,
    runnerControl,
    runnerAgentInstaller,
    runnerAgentResources,
    executionControl,
    runnerProtocol,
    publicStatistics,
    platformOperations,
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

async function runPeriodic(
  signal: AbortSignal,
  intervalMs: number,
  operation: () => Promise<void>,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await operation();
    } catch (error) {
      workerLogger.error("periodic platform operation failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
    await abortableDelay(signal, intervalMs);
  }
}

function abortableDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function offlineCutoff(now: Date): string {
  return new Date(now.getTime() - 90_000).toISOString();
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
