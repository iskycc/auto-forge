import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import {
  AttemptLogShareService,
  CaseDefinitionService,
  CaseSourceService,
  CaseSuiteService,
  CaseSuiteActivityService,
  DdtCaseService,
  DdtImportService,
  DashboardSnapshotService,
  ExecutionControlService,
  FailureAnalysisService,
  ImportTestNgJarService,
  IdentityAccessService,
  JobWorker,
  runWithTransientRecovery,
  PublicPlatformStatisticsService,
  PlatformOperationsService,
  ProjectStructureService,
  RunBatchExportService,
  RunBatchSchedulingService,
  RoundRecoveryConfigurationInspector,
  RoundRecoveryService,
  RunnerControlService,
  RunnerInstallationProfileService,
  RunnerGroupService,
  WebhookNotificationService,
  type ManagedPlatformClock,
  type AttemptLogShareRepository,
  type CaseCatalogRepository,
  type CaseSuiteRepository,
  type CaseSuiteActivityRepository,
  type DdtRepository,
  type DashboardSnapshotRepository,
  type FailureAnalysisRepository,
  type JarObjectStorePort,
  type IdentityAccessRepository,
  type ExecutionControlRepository,
  type CachePort,
  type JobQueuePort,
  type RunBatchRepository,
  type RunBatchDisplayIdentityLookupPort,
  type RoundRecoveryRepository,
  type RunnerRepository,
  type RunnerInstallationProfileRepository,
  type RunnerGroupRepository,
  type PlatformStatisticsRepository,
  type PlatformOperationsRepository,
  type ProjectStructureRepository,
  type WebhookRepository,
} from "@autoforge/application";
import { MemoryCache } from "@autoforge/cache/memory";
import {
  createLocalClock,
  createAttemptLogStore,
  createSqliteDatabase,
  isSqliteLockContentionError,
  SqliteAttemptLogShareRepository,
  SqliteCaseCatalogRepository,
  SqliteCaseSuiteRepository,
  SqliteCaseSuiteActivityRepository,
  SqliteDdtRepository,
  SqliteDashboardSnapshotRepository,
  SqliteExecutionControlRepository,
  SqliteFailureAnalysisRepository,
  SqliteIdentityAccessRepository,
  SqliteRunBatchRepository,
  SqliteRoundRecoveryRepository,
  SqliteRunnerRepository,
  SqliteRunnerInstallationProfileRepository,
  SqliteRunnerGroupRepository,
  SqlitePlatformStatisticsRepository,
  SqlitePlatformOperationsRepository,
  SqliteProjectStructureRepository,
  SqliteWebhookRepository,
} from "@autoforge/db/sqlite";
import { parseDdtUpload } from "@autoforge/ddt-import";
import { LocalObjectStore } from "@autoforge/object-store/local";
import { SqliteJobQueue } from "@autoforge/queue/sqlite";
import { TestNgJarDiscovery } from "@autoforge/testng-discovery";
import { RunnerProtocolController } from "@autoforge/runner-sdk";
import { uuidV7 } from "@autoforge/ids";

import { registerPlatformClock } from "./platform-clock-runtime";
import { appConfigurationStore, loadAppConfig } from "./config";
import { LdapDirectory } from "./ldap-directory";
import { JenkinsRebuildTransport } from "./jenkins-round-recovery";
import { ScryptPasswordHasher } from "./password-hasher";
import { StorageInventoryService } from "./storage-inventory";
import { runnerControlPlaneUrl } from "./platform-configuration";
import { MemoryRequestLimiter, RedisRequestLimiter, type RequestLimiter } from "./request-limiter";
import { natsReconnectOptions, redisReconnectDelay } from "./resilient-connections";
import { RunnerAgentInstaller } from "./runner-agent-installer";
import { RunnerAgentResourceStore } from "./runner-agent-resources";
import {
  issueRunnerBootstrapToken,
  replacementRunnerIdFromBootstrapToken,
  verifyRunnerBootstrapToken,
} from "./runner-bootstrap-token";
import { AesGcmSecretCipher } from "./secret-cipher";
import {
  CoalescingSchedulingPort,
  workDispatcher,
  workerBackedExecutionControlRepository,
} from "./work-dispatch";

export type PlatformServices = Awaited<ReturnType<typeof createPlatformServices>>;

type RuntimeInfrastructure = {
  ready(): Promise<void>;
  close(): Promise<void>;
};

async function createPlatformServices() {
  const config = loadAppConfig();
  let clock: ManagedPlatformClock = createLocalClock();
  const dispatcher = workDispatcher();
  const configurationStore = appConfigurationStore(config);
  let platformNodes: import("@autoforge/application").PlatformNodeRepository | undefined;
  let nodeLogs: import("@autoforge/db/postgres").NodeAttemptLogStore | undefined;
  let catalog: CaseCatalogRepository;
  let suites: CaseSuiteRepository;
  let suiteActivityRepository: CaseSuiteActivityRepository;
  let ddtRepository: DdtRepository;
  let dashboardSnapshotRepository: DashboardSnapshotRepository;
  let failureAnalysisRepository: FailureAnalysisRepository;
  let runners: RunnerRepository;
  let runnerInstallationProfileRepository: RunnerInstallationProfileRepository;
  let runnerGroupsRepository: RunnerGroupRepository;
  let identities: IdentityAccessRepository;
  let executions: ExecutionControlRepository;
  let batches: RunBatchRepository & RunBatchDisplayIdentityLookupPort;
  let roundRecoveries: RoundRecoveryRepository;
  let attemptLogSharesRepository: AttemptLogShareRepository;
  let objectStore: JarObjectStorePort;
  let jobQueue: JobQueuePort;
  let cache: CachePort;
  let statisticsRepository: PlatformStatisticsRepository;
  let operationsRepository: PlatformOperationsRepository;
  let projectStructuresRepository: ProjectStructureRepository;
  let webhookRepository: WebhookRepository;
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
    suiteActivityRepository = new SqliteCaseSuiteActivityRepository(database);
    ddtRepository = new SqliteDdtRepository(database);
    dashboardSnapshotRepository = new SqliteDashboardSnapshotRepository(database);
    runners = new SqliteRunnerRepository(database);
    runnerInstallationProfileRepository = new SqliteRunnerInstallationProfileRepository(database);
    runnerGroupsRepository = new SqliteRunnerGroupRepository(database);
    identities = new SqliteIdentityAccessRepository(database);
    const localExecutions = new SqliteExecutionControlRepository(database, attemptLogs);
    executions = workerBackedExecutionControlRepository(localExecutions, dispatcher);
    failureAnalysisRepository = new SqliteFailureAnalysisRepository(database);
    batches = new SqliteRunBatchRepository(database, config.caseExecutionTimeoutSeconds);
    roundRecoveries = new SqliteRoundRecoveryRepository(database);
    attemptLogSharesRepository = new SqliteAttemptLogShareRepository(database);
    objectStore = new LocalObjectStore(config.dataDirectory);
    jobQueue = new SqliteJobQueue(database);
    cache = new MemoryCache();
    statisticsRepository = new SqlitePlatformStatisticsRepository(database);
    operationsRepository = new SqlitePlatformOperationsRepository(database, attemptLogs);
    projectStructuresRepository = new SqliteProjectStructureRepository(database);
    webhookRepository = new SqliteWebhookRepository(database);
    closeDatabase = async () => {
      attemptLogs.close();
      database.close();
    };
  } else {
    const [
      {
        createPostgresDatabase,
        createPostgresClock,
        PostgresPlatformNodeRepository,
        NodeAttemptLogStore,
        createNodeLogTransport,
        PostgresAttemptLogShareRepository,
        PostgresCaseCatalogRepository,
        PostgresCaseSuiteRepository,
        PostgresCaseSuiteActivityRepository,
        PostgresDdtRepository,
        PostgresDashboardSnapshotRepository,
        PostgresIdentityAccessRepository,
        PostgresExecutionControlRepository,
        PostgresFailureAnalysisRepository,
        PostgresRunBatchRepository,
        PostgresRoundRecoveryRepository,
        PostgresRunnerRepository,
        PostgresRunnerInstallationProfileRepository,
        PostgresRunnerGroupRepository,
        PostgresPlatformStatisticsRepository,
        PostgresPlatformOperationsRepository,
        PostgresProjectStructureRepository,
        PostgresWebhookRepository,
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
    let attemptLogs:
      | import("@autoforge/db/sqlite").AttemptLogStore
      | import("@autoforge/db/postgres").NodeAttemptLogStore = createAttemptLogStore(
      join(config.dataDirectory, "attempt-logs"),
    );
    const database = createPostgresDatabase({
      connectionString: config.databaseUrl,
      migrationsFolder: config.migrationsFolder,
      poolMax: config.databasePoolMax,
    });
    try {
      await database.ready;
      clock = await createPostgresClock(database, (error) => {
        workerLogger.error("Platform clock synchronization failed", {
          error: error instanceof Error ? error.message : "Unknown clock error",
        });
      });
      if (config.distributed) {
        if (!config.nodeId)
          throw new Error("Distributed deployment requires a persistent node ID.");
        platformNodes = new PostgresPlatformNodeRepository(database);
        nodeLogs = new NodeAttemptLogStore(
          database,
          config.nodeId,
          attemptLogs,
          createNodeLogTransport(config.masterKey, config.nodeId, clock),
          join(config.dataDirectory, "attempt-logs"),
          clock,
        );
        await nodeLogs.initialize(join(config.dataDirectory, "attempt-logs"));
        attemptLogs = nodeLogs;
      }
      const nats = await connect({
        servers: config.natsServers,
        ...(config.natsToken ? { token: config.natsToken } : {}),
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
      await clock.close();
      await database.close();
      throw new Error("无法初始化 Full 模式基础设施。", { cause: error });
    }
    catalog = new PostgresCaseCatalogRepository(database);
    suites = new PostgresCaseSuiteRepository(database);
    suiteActivityRepository = new PostgresCaseSuiteActivityRepository(database);
    ddtRepository = new PostgresDdtRepository(database);
    dashboardSnapshotRepository = new PostgresDashboardSnapshotRepository(database);
    runners = new PostgresRunnerRepository(database);
    runnerInstallationProfileRepository = new PostgresRunnerInstallationProfileRepository(database);
    runnerGroupsRepository = new PostgresRunnerGroupRepository(database);
    identities = new PostgresIdentityAccessRepository(database);
    // Full 执行仓储保持内联：r39 基准实测把完成/日志/领取卸载到工作线程虽把
    // 完成请求服务端 p50 从 42ms 降到 28ms，但执行阶段墙钟由客户端驱动未改善，
    // 领取/批次创建反而因车道连接池争用回退；仅补位调度经 runScheduling 交给
    // 工作线程。
    executions = new PostgresExecutionControlRepository(database, attemptLogs);
    failureAnalysisRepository = new PostgresFailureAnalysisRepository(database);
    batches = new PostgresRunBatchRepository(database, config.caseExecutionTimeoutSeconds);
    roundRecoveries = new PostgresRoundRecoveryRepository(database);
    attemptLogSharesRepository = new PostgresAttemptLogShareRepository(database);
    objectStore = new MinioObjectStore(config.minio);
    statisticsRepository = new PostgresPlatformStatisticsRepository(database);
    operationsRepository = new PostgresPlatformOperationsRepository(database, attemptLogs);
    projectStructuresRepository = new PostgresProjectStructureRepository(database);
    webhookRepository = new PostgresWebhookRepository(database);
  }
  const discovery = new TestNgJarDiscovery({
    maxJarBytes: config.maxJarBytes,
    targetJavaVersion: config.testNgTargetJavaVersion,
  });

  const caseSuiteActivity = new CaseSuiteActivityService(
    suiteActivityRepository,
    suites,
    batches,
    clock,
  );
  const ids = { next: () => uuidV7() };
  const secretCipher = new AesGcmSecretCipher(config.masterKey);
  const webhooks = new WebhookNotificationService(
    webhookRepository,
    {
      send: async (request) => {
        const response = await fetch(request.url, {
          method: request.method,
          ...(request.body !== undefined
            ? { headers: { "content-type": "application/json; charset=utf-8" }, body: request.body }
            : {}),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel();
        return { statusCode: response.status };
      },
    },
    clock,
    ids,
  );
  const importTestNgJar = new ImportTestNgJarService({
    discovery,
    objectStore,
    catalog,
    clock,
    ids,
  });
  const caseSources = new CaseSourceService(catalog, objectStore, clock, ids, jobQueue, discovery);
  const jenkinsRoundRecoveryTransport = new JenkinsRebuildTransport();
  const caseSuites = new CaseSuiteService(
    suites,
    catalog,
    projectStructuresRepository,
    clock,
    ids,
    secretCipher,
    ddtRepository,
  );
  const roundRecoveryConfigurationInspector = new RoundRecoveryConfigurationInspector(
    suites,
    jenkinsRoundRecoveryTransport,
    secretCipher,
  );
  const caseDefinitions = new CaseDefinitionService(catalog, clock, ids);
  const ddtCases = new DdtCaseService(ddtRepository, clock, ids);
  const ddtImports = new DdtImportService(
    ddtRepository,
    objectStore,
    { parseUpload: parseDdtUpload },
    clock,
    ids,
  );
  const projectStructures = new ProjectStructureService(
    projectStructuresRepository,
    objectStore,
    clock,
    ids,
  );
  const storageInventory = new StorageInventoryService({
    dataDirectory: config.dataDirectory,
    objectStore,
    projectStructures,
    runBatchDisplayIdentities: batches,
    objectStoreRoot:
      config.mode === "lite"
        ? join(config.dataDirectory, "objects")
        : `minio://${config.minio.bucket}`,
  });
  const runnerCredentials = {
    issue: () => randomBytes(32).toString("base64url"),
    issueBootstrapToken: (replacementRunnerId?: string) =>
      issueRunnerBootstrapToken(config.masterKey, clock.now(), replacementRunnerId),
    hash: (value: string) => createHash("sha256").update(value).digest("hex"),
    verifyBootstrapToken: (value: string) =>
      secureEqual(value, config.runnerBootstrapToken ?? "") ||
      verifyRunnerBootstrapToken(value, config.masterKey, clock.now()),
    replacementRunnerId: (value: string) =>
      replacementRunnerIdFromBootstrapToken(value, config.masterKey, clock.now()),
  };
  const runnerGroups = new RunnerGroupService(runnerGroupsRepository, runners, clock, ids);
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
    { catalog, objectStore },
    config.scheduler.projectMaximumConcurrency,
    config.scheduler.priorityAgingIntervalMinutes,
    projectStructuresRepository,
    runnerGroupsRepository,
    config.caseExecutionTimeoutSeconds * 1_000,
    () => configurationStore.read().limits.artifactCollectionEnabled,
  );
  const runScheduling = new CoalescingSchedulingPort(runBatches, dispatcher);
  // 日志公开访问 token 与 Runner 凭据同构：随机 base64url，库中只留 SHA-256 哈希。
  const attemptLogShares = new AttemptLogShareService(
    attemptLogSharesRepository,
    batches,
    executions,
    {
      issue: () => randomBytes(32).toString("base64url"),
      hash: (value) => createHash("sha256").update(value).digest("hex"),
    },
    clock,
    ids,
  );
  const failureAnalysis = new FailureAnalysisService(
    failureAnalysisRepository,
    clock,
    ids,
    objectStore,
    attemptLogShares,
  );
  const roundRecovery = new RoundRecoveryService(
    roundRecoveries,
    jenkinsRoundRecoveryTransport,
    secretCipher,
    batches,
    runScheduling,
    clock,
    ids,
  );
  const runnerControl = new RunnerControlService(
    runners,
    runnerCredentials,
    executions,
    clock,
    ids,
    batches,
    runScheduling,
    runnerInstallationProfileRepository,
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
  const dashboardSnapshots = new DashboardSnapshotService(
    dashboardSnapshotRepository,
    catalog,
    operationsRepository,
    clock,
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
          await runScheduling.schedule(batchId);
        },
        "object-cleanup": caseSources.objectCleanupHandler(),
        "jar-import": importTestNgJar.jobHandler(),
        "ddt-import": ddtImports.jobHandler(),
        "analytics-export": platformOperations.analyticsExportJobHandler(),
      },
      clock,
      {
        workerId: `lite-web-${process.pid}`,
        concurrency: config.worker.concurrency,
        leaseDurationMs: 30_000,
        minimumPollMs: 100,
        maximumPollMs: 2_000,
      },
      workerLogger,
    );
    const workerRun = runWithTransientRecovery(
      workerAbort.signal,
      () => worker.run(workerAbort.signal),
      workerLogger,
      {
        operationName: "Lite embedded job worker",
        shouldKeepRecovering: isSqliteLockContentionError,
      },
    ).catch((error: unknown) => {
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
  const runnerInstallationProfiles = new RunnerInstallationProfileService(
    runnerInstallationProfileRepository,
    secretCipher,
    clock,
    ids,
  );
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
    runScheduling,
  );
  const runnerProtocol = new RunnerProtocolController(executionControl);
  const runBatchExport = new RunBatchExportService(batches);
  const publicStatistics = new PublicPlatformStatisticsService(
    statisticsRepository,
    clock,
    60_000,
    config.publicDashboardRefreshSeconds,
  );
  const scheduleAbort = new AbortController();
  const roundRecoveryLoop = runPeriodic(scheduleAbort.signal, 5_000, async () => {
    await roundRecovery.dispatchDue(`web-${process.pid}-round-recovery`);
  });
  const scheduleLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 30_000, async () => {
          await platformOperations.triggerDueSchedules(async (schedule) => {
            const batch = await runBatches.create({
              suiteId: schedule.suiteId,
            });
            return batch.id;
          });
          await platformOperations.generateNotifications();
          await webhooks.dispatchDue(`lite-web-${process.pid}-webhooks`);
          await operationsRepository.rebuildAnalyticsFacts(1_000);
        })
      : Promise.resolve();
  const dashboardSnapshotLoop =
    config.mode === "lite"
      ? runPeriodic(
          scheduleAbort.signal,
          config.publicDashboardRefreshSeconds * 1_000,
          async () => {
            await dashboardSnapshots.refreshTracked();
          },
        )
      : Promise.resolve();
  const nodeCleanupLoop = nodeLogs
    ? runPeriodic(scheduleAbort.signal, 60_000, () => nodeLogs!.cleanupOrphans())
    : Promise.resolve();
  const retentionLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 3_600_000, async () => {
          await platformOperations.runRetentionCycle();
        })
      : Promise.resolve();
  const runtimeInfrastructure = infrastructure;
  infrastructure = {
    ready: async () => {
      clock.now();
      await runtimeInfrastructure.ready();
    },
    close: async () => {
      scheduleAbort.abort();
      await Promise.all([
        scheduleLoop,
        dashboardSnapshotLoop,
        retentionLoop,
        roundRecoveryLoop,
        nodeCleanupLoop,
      ]);
      await clock.close();
      await runtimeInfrastructure.close();
    },
  };
  globalServices.__autoforgeClosePlatformServices = infrastructure.close;
  const runnerAgentResources = new RunnerAgentResourceStore(
    join(config.workspaceRoot, "resources", "agents"),
  );
  const runnerAgentInstaller = new RunnerAgentInstaller({
    resources: runnerAgentResources,
    controlPlaneUrl: () => runnerControlPlaneUrl(configurationStore.read().web),
    issueBootstrapToken: (replacementRunnerId?: string) =>
      runnerControl.issueBootstrapToken(replacementRunnerId),
  });

  registerPlatformClock(clock);
  return {
    clock,
    config,
    configurationStore,
    platformNodes,
    nodeLogs,
    catalog,
    discovery,
    objectStore,
    importTestNgJar,
    caseSources,
    suites,
    caseSuites,
    caseSuiteActivity,
    roundRecoveryConfigurationInspector,
    caseDefinitions,
    ddtCases,
    ddtImports,
    projectStructures,
    storageInventory,
    runners,
    identities,
    executions,
    identityAccess,
    runnerControl,
    runnerGroups,
    runnerAgentInstaller,
    runnerInstallationProfiles,
    runnerAgentResources,
    executionControl,
    runnerProtocol,
    attemptLogShares,
    runBatchExport,
    publicStatistics,
    dashboardSnapshots,
    platformOperations,
    webhooks,
    runBatches,
    failureAnalysis,
    runScheduling,
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

const globalServices = globalThis as typeof globalThis & {
  __autoforgePlatformServices?: Promise<PlatformServices> | undefined;
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
  // 初始化失败不得永久记忆化：清除缓存让后续请求重试，避免启动期瞬时失败
  //（如 Lite 老库升级迁移持锁）把整个进程钉在 500 直到重启。
  globalServices.__autoforgePlatformServices ??= createPlatformServices().catch(
    (error: unknown) => {
      globalServices.__autoforgePlatformServices = undefined;
      throw error;
    },
  );
  return globalServices.__autoforgePlatformServices;
}
