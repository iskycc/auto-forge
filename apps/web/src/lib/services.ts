import { ArchivedAttemptLogStore, SqliteLogArchiveRepository } from "@autoforge/db/sqlite";
import { readOnlyLegacyAttemptLogs } from "@autoforge/db/sqlite";
import { LogArchiveService, type LogArchiveRepository } from "@autoforge/application";
import {
  PublicSuiteExecutionService,
  type PublicSuiteExecutionRepository,
} from "@autoforge/application";
import {
  SqlitePublicSuiteExecutionRepository,
  PostgresPublicSuiteExecutionRepository,
} from "@autoforge/db";
import {
  runtimeDiagnosticContext,
  isRuntimeDatabaseContention,
} from "@autoforge/contracts/runtime-diagnostics";
import { prioritizedExecutionControlRepository } from "./work-dispatch";
import { runtimePriority } from "./runtime-priority";
import { SystemDiagnosticReader } from "./system-diagnostics";
import { InfrastructureUsageReader } from "./infrastructure-usage";
import type { InfrastructureUsageSample } from "@autoforge/contracts";
import { readDiagnosticRuntime } from "./diagnostic-runtime";
import { mkdir } from "node:fs/promises";
import { isolatedAttemptLogs } from "./isolated-attempt-logs";
import { DEFAULT_PROJECT_ID, DomainError } from "@autoforge/domain";
import {
  publicPlatformStatisticsSchema,
  parsedDdtAssociationImportSchema,
} from "@autoforge/contracts";
import {
  readBatchPage,
  readExecutionOverview,
  readExecutionExceptions,
  prepareExecutionExceptionExport,
} from "@autoforge/application";
import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import {
  AttemptLogShareService,
  PublicExecutionAccessService,
  RuntimeNotificationService,
  CaseDefinitionService,
  CaseSourceService,
  CaseSuiteService,
  CaseSuiteActivityService,
  ConcurrencyDiagnosticsService,
  DdtCaseService,
  DdtAssociationTransferService,
  DdtSrTagService,
  DdtSrTagImportService,
  type DdtSrTagRepository,
  DdtImportService,
  DdtDebugService,
  DdtChangeRequestService,
  type DdtChangeRequestRepository,
  type DdtDebugRepository,
  DashboardSnapshotService,
  ReadModelSnapshotService,
  type ReadModelSnapshotRepository,
  ExecutionControlService,
  FailureAnalysisService,
  ImportTestNgJarService,
  IdentityAccessService,
  JobWorker,
  runWithTransientRecovery,
  PlatformOperationsService,
  ProjectStructureService,
  ProjectVersionCopyRequests,
  authorizeVersionCopyActor,
  type ProjectVersionCopyRepository,
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
  type PublicExecutionAccessRepository,
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
  SqlitePublicExecutionAccessRepository,
  SqliteCaseCatalogRepository,
  SqliteCaseSuiteRepository,
  SqliteCaseSuiteActivityRepository,
  SqliteDdtRepository,
  SqliteDdtSrTagRepository,
  SqliteDdtDebugRepository,
  SqliteDdtChangeRequestRepository,
  SqliteDashboardSnapshotRepository,
  SqliteReadModelSnapshotRepository,
  SqliteExecutionControlRepository,
  SqliteFailureAnalysisRepository,
  SqliteIdentityAccessRepository,
  SqliteRunBatchRepository,
  SqliteRoundRecoveryRepository,
  SqliteRunnerRepository,
  SqliteRunnerInstallationProfileRepository,
  SqliteRunnerGroupRepository,
  SqlitePlatformOperationsRepository,
  SqliteProjectStructureRepository,
  SqliteProjectVersionCopyRepository,
  SqliteWebhookRepository,
} from "@autoforge/db/sqlite";
import { parseDdtUpload, parseSrTagSpreadsheet } from "@autoforge/ddt-import";
import {
  isolatedJarDiscovery,
  isolatedDdtSpreadsheets,
  isolatedSrTagSpreadsheets,
} from "./isolated-file-parsing";
import { LocalObjectStore } from "@autoforge/object-store/local";
import { RuntimeArchiveCache } from "@autoforge/object-store/runtime-archive-cache";
import { SqliteJobQueue } from "@autoforge/queue/sqlite";
import { TestNgJarDiscovery } from "@autoforge/testng-discovery";
import { RunnerProtocolController } from "@autoforge/runner-sdk";
import { uuidV7 } from "@autoforge/ids";

import { registerPlatformClock } from "./platform-clock-runtime";
import { logServerError } from "./api-error-mapping";
import { detectRuntimeResources } from "@autoforge/platform-config/runtime-resources";
import { appConfigurationStore, loadAppConfig } from "./config";
import { LdapDirectory } from "./ldap-directory";
import { JenkinsRebuildTransport } from "./jenkins-round-recovery";
import { ScryptPasswordHasher } from "./password-hasher";
import { createStorageInventoryReader } from "./storage-inventory-reader";
import { StorageInventoryService } from "./storage-inventory";
import { runnerControlPlaneUrl } from "./platform-configuration";
import { MemoryRequestLimiter, RedisRequestLimiter, type RequestLimiter } from "./request-limiter";
import {
  awaitRedisReply,
  natsReconnectOptions,
  redisReconnectDelay,
  redisRuntimeCommandOptions,
} from "./resilient-connections";
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
  workerBackedBatchCreation,
  workerBackedDdtReads,
  workDispatcher,
  workerBackedExecutionControlRepository,
  workerBackedExecutionViewReads,
  workerBackedRunnerResourceReads,
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
  let routedLogs: import("@autoforge/db/postgres").PostgresRoutedAttemptLogStore | undefined;
  let logArchiveRepository: LogArchiveRepository;
  let logDatabases: import("@autoforge/application").LogDatabaseService | undefined;
  let catalog: CaseCatalogRepository;
  let suites: CaseSuiteRepository;
  let suiteActivityRepository: CaseSuiteActivityRepository;
  let ddtRepository: DdtRepository;
  let srTagRepository: DdtSrTagRepository;
  let ddtDebugRepository: DdtDebugRepository;
  let ddtChangeRepository: DdtChangeRequestRepository;
  let dashboardSnapshotRepository: DashboardSnapshotRepository;
  let readModelRepository: ReadModelSnapshotRepository;
  let failureAnalysisRepository: FailureAnalysisRepository;
  let runners: RunnerRepository;
  let runnerInstallationProfileRepository: RunnerInstallationProfileRepository;
  let runnerGroupsRepository: RunnerGroupRepository;
  let identities: IdentityAccessRepository;
  let executions: ExecutionControlRepository;
  let batches: RunBatchRepository & RunBatchDisplayIdentityLookupPort;
  let roundRecoveries: RoundRecoveryRepository;
  let attemptLogSharesRepository: AttemptLogShareRepository;
  let publicExecutionAccessRepository: PublicExecutionAccessRepository;
  let publicSuiteExecutionRepository: PublicSuiteExecutionRepository;
  let objectStore: JarObjectStorePort;
  let jobQueue: JobQueuePort;
  let cache: CachePort;
  let operationsRepository: PlatformOperationsRepository;
  let projectStructuresRepository: ProjectStructureRepository;
  let versionCopyRepository: ProjectVersionCopyRepository & { close(): Promise<void> };
  let webhookRepository: WebhookRepository;
  let closeDatabase: () => Promise<void>;
  let runnerRequestLimiter: RequestLimiter = new MemoryRequestLimiter();
  let infrastructure: RuntimeInfrastructure | undefined;
  let databaseReady: () => Promise<void>;
  let logWriteAdmission: import("@autoforge/application").ExecutionLogWriteAdmission | undefined;
  let diagnosticProviders: Record<"database" | "objectStore" | "queue" | "cache", string>;
  let databaseUsage: () => Promise<InfrastructureUsageSample>;
  let cacheUsage: () => Promise<InfrastructureUsageSample>;
  let queueUsage: () => Promise<InfrastructureUsageSample>;
  let objectStoreUsage: () => Promise<InfrastructureUsageSample>;
  if (config.mode === "lite") {
    const database = createSqliteDatabase({
      databasePath: config.databasePath,
      migrationsFolder: config.migrationsFolder,
      busyTimeoutMs: 25,
    });
    databaseReady = async () => {
      database.client.prepare("SELECT 1").get();
    };
    databaseUsage = async () => {
      const pages = database.client.pragma("page_count", { simple: true }) as number;
      const pageSize = database.client.pragma("page_size", { simple: true }) as number;
      const freePages = database.client.pragma("freelist_count", { simple: true }) as number;
      return {
        metrics: [
          { key: "pages", label: "数据库页数", value: pages, unit: "count" },
          { key: "bytes", label: "数据库文件逻辑占用", value: pages * pageSize, unit: "bytes" },
          {
            key: "reusable",
            label: "数据库内可复用页",
            value: freePages * pageSize,
            unit: "bytes",
          },
          {
            key: "journal",
            label: "日志模式",
            value: String(database.client.pragma("journal_mode", { simple: true })),
            unit: "text",
          },
        ],
        notes: ["Lite 使用本地 SQLite；可复用页属于数据库内部空间，不是宿主机磁盘可用容量。"],
      };
    };
    diagnosticProviders = {
      database: "SQLite · WAL",
      objectStore: "本地文件系统",
      queue: "SQLite 持久队列",
      cache: "进程内缓存",
    };
    const attemptLogs = createAttemptLogStore(join(config.dataDirectory, "attempt-logs"));
    logArchiveRepository = new SqliteLogArchiveRepository(database);
    objectStore = new LocalObjectStore(config.dataDirectory);
    const archivedLogs = new ArchivedAttemptLogStore(
      isolatedAttemptLogs(join(config.dataDirectory, "attempt-logs")),
      logArchiveRepository,
      objectStore,
    );
    catalog = new SqliteCaseCatalogRepository(database);
    suites = new SqliteCaseSuiteRepository(database);
    suiteActivityRepository = new SqliteCaseSuiteActivityRepository(database);
    ddtRepository = new SqliteDdtRepository(database);
    srTagRepository = new SqliteDdtSrTagRepository(database);
    ddtDebugRepository = new SqliteDdtDebugRepository(database);
    ddtChangeRepository = new SqliteDdtChangeRequestRepository(database);
    dashboardSnapshotRepository = new SqliteDashboardSnapshotRepository(database);
    readModelRepository = new SqliteReadModelSnapshotRepository(database);
    runners = new SqliteRunnerRepository(database);
    runnerInstallationProfileRepository = new SqliteRunnerInstallationProfileRepository(database);
    runnerGroupsRepository = new SqliteRunnerGroupRepository(database);
    identities = new SqliteIdentityAccessRepository(database);
    const localExecutions = new SqliteExecutionControlRepository(
      database,
      attemptLogs,
      archivedLogs,
    );
    executions = workerBackedExecutionControlRepository(localExecutions, dispatcher);
    failureAnalysisRepository = new SqliteFailureAnalysisRepository(database);
    batches = new SqliteRunBatchRepository(database, config.caseExecutionTimeoutSeconds);
    roundRecoveries = new SqliteRoundRecoveryRepository(database);
    attemptLogSharesRepository = new SqliteAttemptLogShareRepository(database);
    publicExecutionAccessRepository = new SqlitePublicExecutionAccessRepository(database);
    publicSuiteExecutionRepository = new SqlitePublicSuiteExecutionRepository(database);

    jobQueue = new SqliteJobQueue(database);
    const memoryCache = new MemoryCache();
    cache = memoryCache;
    cacheUsage = () => memoryCache.readUsage();
    queueUsage = async () => {
      const depth = await jobQueue.depth();
      return {
        metrics: [
          { key: "available", label: "待领取消息", value: depth.available, unit: "count" },
          { key: "leased", label: "已领取消息", value: depth.leased, unit: "count" },
          { key: "dead", label: "死信消息", value: depth.deadLetter, unit: "count" },
        ],
        notes: ["Lite 使用 SQLite 持久队列，消息与租约持久化，不需要 NATS。"],
      };
    };
    objectStoreUsage = async () => {
      await objectStore.ready();
      return {
        metrics: [],
        notes: ["Lite 对象存放在平台数据卷，由本地文件系统持久化，不需要 MinIO。"],
      };
    };
    operationsRepository = new SqlitePlatformOperationsRepository(database, archivedLogs);
    projectStructuresRepository = new SqliteProjectStructureRepository(database);
    versionCopyRepository = new SqliteProjectVersionCopyRepository(database);
    webhookRepository = new SqliteWebhookRepository(database);
    closeDatabase = async () => {
      await versionCopyRepository.close();
      attemptLogs.close();
      database.close();
    };
  } else {
    const [
      {
        createPostgresDatabase,
        createPostgresClock,
        readPostgresInfrastructureUsage,
        PostgresPlatformNodeRepository,
        NodeAttemptLogStore,
        PostgresLogDatabaseRepository,
        PostgresLogWriteAdmission,
        PostgresRoutedAttemptLogStore,
        createNodeLogTransport,
        PostgresAttemptLogShareRepository,
        PostgresPublicExecutionAccessRepository,
        PostgresCaseCatalogRepository,
        PostgresCaseSuiteRepository,
        PostgresCaseSuiteActivityRepository,
        PostgresDdtRepository,
        PostgresDdtSrTagRepository,
        PostgresDdtDebugRepository,
        PostgresDdtChangeRequestRepository,
        PostgresDashboardSnapshotRepository,
        PostgresReadModelSnapshotRepository,
        PostgresIdentityAccessRepository,
        PostgresProjectVersionCopyRepository,
        PostgresExecutionControlRepository,
        PostgresFailureAnalysisRepository,
        PostgresRunBatchRepository,
        PostgresRoundRecoveryRepository,
        PostgresRunnerRepository,
        PostgresRunnerInstallationProfileRepository,
        PostgresRunnerGroupRepository,
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
    await mkdir(join(config.dataDirectory, "attempt-logs"), { recursive: true });
    let attemptLogs:
      | import("@autoforge/db/sqlite").AsyncAttemptLogStore
      | import("@autoforge/db/postgres").NodeAttemptLogStore = readOnlyLegacyAttemptLogs(
      isolatedAttemptLogs(join(config.dataDirectory, "attempt-logs")),
    );
    const database = createPostgresDatabase({
      connectionString: config.databaseUrl,
      migrationsFolder: config.migrationsFolder,
      poolMax: config.databasePoolMax,
    });
    logWriteAdmission = new PostgresLogWriteAdmission(database);
    databaseReady = async () => {
      await database.pool.query("SELECT 1");
    };
    databaseUsage = () => readPostgresInfrastructureUsage(database.pool, new Date());
    diagnosticProviders = {
      database: "PostgreSQL",
      objectStore: "MinIO / S3",
      queue: "NATS JetStream",
      cache: "Redis",
    };
    // A completion may wait for log disk I/O. Reserve the Web pool for pages,
    // authentication and metadata instead of allowing those transactions to occupy it.
    const executionDatabase = createPostgresDatabase({
      connectionString: config.databaseUrl,
      migrationsFolder: config.migrationsFolder,
      poolMax: Math.min(
        config.databasePoolMax,
        Math.max(4, Math.ceil(detectRuntimeResources().cpuCapacity / 2)),
      ),
    });
    for (const handle of [database, executionDatabase]) {
      handle.pool.on("error", (error) => {
        runtimePriority().report(
          "database_busy",
          runtimeDiagnosticContext(error, {
            operation: "postgresql.idleConnection",
            database: "postgresql",
          }),
        );
        logServerError(
          error,
          "postgres-idle-connection",
          "PostgreSQL idle connection lost; the pool will reconnect",
        );
      });
    }
    try {
      await Promise.all([database.ready, executionDatabase.ready]);
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
      const logRegistry = new PostgresLogDatabaseRepository(
        database,
        new AesGcmSecretCipher(config.masterKey),
        createHash("sha256").update(config.masterKey).digest("hex"),
        join(config.migrationsFolder, "../log-postgresql"),
      );
      routedLogs = new PostgresRoutedAttemptLogStore(logRegistry, attemptLogs);
      if (config.logServer)
        await logRegistry.initializeDaily(config.logServer, uuidV7(), clock.now().toISOString());
      attemptLogs = routedLogs;
      const { LogDatabaseService } = await import("@autoforge/application");
      logDatabases = new LogDatabaseService(logRegistry, clock, { next: () => uuidV7() });
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
      const fullQueue = await JetStreamJobQueue.create(nats.jetstream(), jetStreamManager);
      jobQueue = fullQueue;
      queueUsage = () => fullQueue.readUsage();
      const redis = createClient({
        url: config.redisUrl,
        ...redisRuntimeCommandOptions,
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
      const fullCache = new RedisCache(
        {
          get: (key) => awaitRedisReply(redis.get(key)),
          set: (key, value, options) => awaitRedisReply(redis.set(key, value, options)),
          del: (key) => awaitRedisReply(redis.del(key)),
          info: () => awaitRedisReply(redis.info()),
        },
        Number(new URL(config.redisUrl).pathname.slice(1)) || 0,
      );
      cache = fullCache;
      cacheUsage = () => fullCache.readUsage();
      closeDatabase = async () => {
        await versionCopyRepository.close();
        await attemptLogs.close();
        await Promise.all([database.close(), executionDatabase.close()]);
      };
      runnerRequestLimiter = new RedisRequestLimiter((script, options) =>
        awaitRedisReply(redis.eval(script, options)),
      );
      infrastructure = {
        ready: async () => {
          await Promise.all([jobQueue.ready(), awaitRedisReply(redis.ping())]);
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
      await Promise.allSettled([database.close(), executionDatabase.close()]);
      throw new Error("无法初始化 Full 模式基础设施。", { cause: error });
    }
    catalog = new PostgresCaseCatalogRepository(database);
    suites = new PostgresCaseSuiteRepository(database);
    suiteActivityRepository = new PostgresCaseSuiteActivityRepository(database);
    ddtRepository = new PostgresDdtRepository(database);
    srTagRepository = new PostgresDdtSrTagRepository(database);
    ddtDebugRepository = new PostgresDdtDebugRepository(database);
    ddtChangeRepository = new PostgresDdtChangeRequestRepository(database);
    dashboardSnapshotRepository = new PostgresDashboardSnapshotRepository(database);
    readModelRepository = new PostgresReadModelSnapshotRepository(database);
    runners = new PostgresRunnerRepository(database);
    runnerInstallationProfileRepository = new PostgresRunnerInstallationProfileRepository(database);
    runnerGroupsRepository = new PostgresRunnerGroupRepository(database);
    identities = new PostgresIdentityAccessRepository(database);
    // Full 执行仓储保持内联：r39 基准实测把完成/日志/领取卸载到工作线程虽把
    // 完成请求服务端 p50 从 42ms 降到 28ms，但执行阶段墙钟由客户端驱动未改善，
    // 领取/批次创建反而因车道连接池争用回退；仅补位调度经 runScheduling 交给
    // 工作线程。
    const minioStore = new MinioObjectStore(config.minio);
    objectStore = minioStore;
    objectStoreUsage = () => minioStore.readUsage();
    const { PostgresLogArchiveRepository } = await import("@autoforge/db/postgres");
    logArchiveRepository = new PostgresLogArchiveRepository(database);
    attemptLogs = new ArchivedAttemptLogStore(attemptLogs, logArchiveRepository, objectStore);
    executions = prioritizedExecutionControlRepository(
      new PostgresExecutionControlRepository(executionDatabase, attemptLogs),
      () => runtimePriority().beginForeground(),
    );
    failureAnalysisRepository = new PostgresFailureAnalysisRepository(database);
    batches = new PostgresRunBatchRepository(database, config.caseExecutionTimeoutSeconds);
    roundRecoveries = new PostgresRoundRecoveryRepository(database);
    attemptLogSharesRepository = new PostgresAttemptLogShareRepository(database);
    publicExecutionAccessRepository = new PostgresPublicExecutionAccessRepository(database);
    publicSuiteExecutionRepository = new PostgresPublicSuiteExecutionRepository(database);

    operationsRepository = new PostgresPlatformOperationsRepository(database, attemptLogs);
    projectStructuresRepository = new PostgresProjectStructureRepository(database);
    versionCopyRepository = new PostgresProjectVersionCopyRepository(database);
    webhookRepository = new PostgresWebhookRepository(database);
  }
  const discovery = isolatedJarDiscovery(
    new TestNgJarDiscovery({
      maxJarBytes: config.maxJarBytes,
      targetJavaVersion: config.testNgTargetJavaVersion,
    }),
    dispatcher,
  );

  ddtRepository = workerBackedDdtReads(ddtRepository, dispatcher);
  batches = workerBackedExecutionViewReads(batches, dispatcher);
  runners = workerBackedRunnerResourceReads(runners, dispatcher);
  const caseSuiteActivity = new CaseSuiteActivityService(
    suiteActivityRepository,
    suites,
    batches,
    clock,
  );
  const ids = { next: () => uuidV7() };
  const versionCopies = new ProjectVersionCopyRequests({
    repository: versionCopyRepository,
    clock,
    ids,
    authorize: (actorId, source, target) =>
      authorizeVersionCopyActor(identities, actorId, source, target),
  });
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
  const readModels = new ReadModelSnapshotService(readModelRepository, clock);
  const importTestNgJar = new ImportTestNgJarService({
    readModelInvalidation: readModels,
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
    () => configurationStore.read().web.timeZone,
  );
  const roundRecoveryConfigurationInspector = new RoundRecoveryConfigurationInspector(
    suites,
    jenkinsRoundRecoveryTransport,
    secretCipher,
  );
  const caseDefinitions = new CaseDefinitionService(catalog, clock, ids);
  const ddtCases = new DdtCaseService(ddtRepository, clock, ids, catalog);
  const ddtDebug = new DdtDebugService(ddtDebugRepository, ddtRepository, clock, ids);
  const ddtChanges = new DdtChangeRequestService(
    ddtChangeRepository,
    ddtDebugRepository,
    ddtRepository,
    clock,
    ids,
  );
  const ddtImports = new DdtImportService(
    ddtRepository,
    objectStore,
    isolatedDdtSpreadsheets(
      { parseUpload: (upload, limits) => parseDdtUpload(upload, limits, { compactRows: true }) },
      dispatcher,
    ),
    clock,
    ids,
    readModels,
    () => {
      const limits = configurationStore.read().limits;
      return {
        maximumUploadFiles: limits.ddtImportFileLimit,
        maximumZipSpreadsheets: limits.ddtImportZipSpreadsheetLimit,
      };
    },
    ddtDebugRepository,
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
  const runBatches = workerBackedBatchCreation(
    new RunBatchSchedulingService(
      batches,
      suites,
      runners,
      clock,
      ids,
      {
        maximumCpuUtilizationPercent: config.scheduler.maximumCpuUtilizationPercent,
        maximumMemoryUtilizationPercent: config.scheduler.maximumMemoryUtilizationPercent,
        memoryAdmissionMode: config.scheduler.memoryAdmissionMode ?? "reserved",
        maximumLoadPerCpu: config.scheduler.maximumLoadPerCpu,
      },
      config.scheduler.metricsMaximumAgeSeconds,
      {
        catalog,
        projects: identities,
        objectStore,
        ddt: ddtRepository,
        ddtDebug: ddtDebugRepository,
      },
      config.scheduler.projectMaximumConcurrency,
      config.scheduler.priorityAgingIntervalMinutes,
      projectStructuresRepository,
      runnerGroupsRepository,
      config.caseExecutionTimeoutSeconds * 1_000,
      () => configurationStore.read().limits.artifactCollectionEnabled,
      () => configurationStore.readScheduler(),
      logWriteAdmission,
    ),
    config.mode === "lite" ? dispatcher : undefined,
    dispatcher,
  );
  const runScheduling = new CoalescingSchedulingPort(runBatches, dispatcher);
  // Legacy opaque log URLs remain readable; new URLs use persisted business-ID grants.
  const attemptLogShares = new AttemptLogShareService(
    attemptLogSharesRepository,
    batches,
    executions,
    {
      hash: (value) => createHash("sha256").update(value).digest("hex"),
    },
    clock,
  );
  const publicExecutionAccess = new PublicExecutionAccessService(
    publicExecutionAccessRepository,
    batches,
    executions,
    attemptLogShares,
    clock,
  );
  const failureAnalysis = new FailureAnalysisService(
    failureAnalysisRepository,
    clock,
    ids,
    objectStore,
    publicExecutionAccess,
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
    const workers = (["execution", "background"] as const).map(
      (workClass) =>
        new JobWorker(
          jobQueue,
          {
            "dispatch-run": async (job) => {
              const batchId = job.payload.batchId;
              if (typeof batchId !== "string") throw new Error("Dispatch job batchId is invalid.");
              await runScheduling.schedule(batchId);
            },
            "object-cleanup": dispatcher
              ? (job, signal) => dispatcher.executeBackgroundJob(job, signal)
              : caseSources.objectCleanupHandler(),
            "jar-import": dispatcher
              ? (job, signal) => dispatcher.executeBackgroundJob(job, signal)
              : importTestNgJar.jobHandler(),
            "ddt-import": dispatcher
              ? (job, signal) => dispatcher.executeBackgroundJob(job, signal)
              : ddtImports.jobHandler(),
            "ddt-debug-import": dispatcher
              ? (job, signal) => dispatcher.executeBackgroundJob(job, signal)
              : ddtImports.jobHandler(),
            "analytics-export": dispatcher
              ? (job, signal) => dispatcher.executeBackgroundJob(job, signal)
              : platformOperations.analyticsExportJobHandler(),
            "project-version-copy": async (job, signal) => {
              if (!dispatcher) throw new Error("Version copying requires the background worker.");
              await dispatcher.executeBackgroundJob(job, signal);
            },
          },
          clock,
          {
            workerId: `lite-web-${process.pid}-${workClass}`,
            workClass,
            ...(workClass === "background"
              ? { canClaim: () => runtimePriority().backgroundAllowed() }
              : {}),
            concurrency:
              workClass === "background"
                ? (dispatcher?.backgroundConcurrency ?? 1)
                : config.worker.concurrency,
            leaseDurationMs: 30_000,
            minimumPollMs: 100,
            maximumPollMs: 2_000,
          },
          workerLogger,
        ),
    );
    const workerRun = Promise.all(
      workers.map((worker) =>
        runWithTransientRecovery(
          workerAbort.signal,
          () => worker.run(workerAbort.signal),
          workerLogger,
          {
            operationName: "Lite embedded job worker",
            shouldKeepRecovering: isSqliteLockContentionError,
          },
        ),
      ),
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
    readModels,
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
  const publicStatistics = {
    read: async () => {
      const projection = await readModels.read({
        kind: "public_statistics",
        projectId: DEFAULT_PROJECT_ID,
        refreshSeconds: config.publicDashboardRefreshSeconds,
      });
      return publicPlatformStatisticsSchema.parse({
        ...(projection.payload ?? {
          sourceCount: 0,
          caseCount: 0,
          methodCount: 0,
          enabledMethodCount: 0,
          runnerCount: 0,
          onlineRunnerCount: 0,
          busyRunnerCount: 0,
          activeBatchCount: 0,
          completedBatchCount: 0,
          totalRunCount: 0,
          succeededRunCount: 0,
          failedRunCount: 0,
          successRatePercent: 0,
          generatedAt: clock.now().toISOString(),
          refreshSeconds: 5,
        }),
        snapshotState: projection.state,
      });
    },
  };
  const scheduleAbort = new AbortController();
  const runtimeNotifications = new RuntimeNotificationService(
    identities,
    operationsRepository,
    runtimePriority(),
    clock,
    config.mode === "full" ? (config.nodeId ?? "local") : "local",
  );
  const runtimeNoticeLoop = runPeriodic(scheduleAbort.signal, 5_000, "notifications.deliver", () =>
    runtimeNotifications.deliverNextPage(),
  );
  const roundRecoveryLoop = runPeriodic(
    scheduleAbort.signal,
    5_000,
    "round-recovery.dispatch",
    async () => {
      await roundRecovery.dispatchDue(`web-${process.pid}-round-recovery`);
    },
  );
  const scheduleLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 30_000, "schedules.trigger", async () => {
          if (dispatcher?.triggerDueSchedules) await dispatcher.triggerDueSchedules();
          else
            await platformOperations.triggerDueSchedules(async (schedule) => {
              const batch = await runBatches.create({
                suiteId: schedule.suiteId,
              });
              return batch.id;
            });
        })
      : Promise.resolve();
  const logArchiveLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 5000, "logs.archive", async () => {
          if (dispatcher && runtimePriority().backgroundAllowed())
            await dispatcher.runPlatformMaintenance("log-archives");
        })
      : Promise.resolve();
  const notificationLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 30_000, "notifications.generate", async () => {
          if (!runtimePriority().backgroundAllowed()) return;
          if (dispatcher) await dispatcher.runPlatformMaintenance("notifications");
          else await platformOperations.generateNotifications(100);
        })
      : Promise.resolve();
  const webhookLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 30_000, "webhooks.dispatch", async () => {
          if (runtimePriority().backgroundAllowed())
            await webhooks.dispatchDue(`lite-web-${process.pid}-webhooks`);
        })
      : Promise.resolve();
  const nodeCleanupLoop =
    nodeLogs || routedLogs
      ? runPeriodic(scheduleAbort.signal, 60_000, "logs.cleanupOrphans", async () => {
          if (runtimePriority().backgroundAllowed()) {
            await routedLogs?.cleanupOrphans();
            await nodeLogs?.cleanupOrphans();
          }
        })
      : Promise.resolve();
  const retentionLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 3_600_000, "retention.cleanup", async () => {
          if (!runtimePriority().backgroundAllowed()) return;
          if (dispatcher) await dispatcher.runPlatformMaintenance("retention");
          else await platformOperations.runRetentionCycle(100);
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
        notificationLoop,
        logArchiveLoop,
        webhookLoop,
        retentionLoop,
        roundRecoveryLoop,
        nodeCleanupLoop,
        runtimeNoticeLoop,
      ]);
      await storageInventory.close();
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
  const diagnosticResources = detectRuntimeResources();
  const diagnostics = new SystemDiagnosticReader({
    mode: config.mode,
    clock,
    dataDirectory: config.dataDirectory,
    configurationRevision: () => configurationStore.read().revision,
    dependencies: {
      database: { provider: diagnosticProviders.database, check: databaseReady },
      objectStore: { provider: diagnosticProviders.objectStore, check: () => objectStore.ready() },
      queue: { provider: diagnosticProviders.queue, check: () => jobQueue.ready() },
      cache: {
        provider: diagnosticProviders.cache,
        check: () => cache.get("diagnostics", "system", 1, "readiness"),
      },
    },
    queue: jobQueue,
    runtime: () =>
      readDiagnosticRuntime(
        diagnosticResources,
        config.mode === "full"
          ? { ...(config.nodeId ? { nodeId: config.nodeId } : {}), distributed: config.distributed }
          : { distributed: false },
        runtimePriority().backgroundAllowed(),
      ),
  });
  const infrastructureUsage = new InfrastructureUsageReader({
    database: { provider: diagnosticProviders.database, read: databaseUsage },
    cache: { provider: diagnosticProviders.cache, read: cacheUsage },
    queue: { provider: diagnosticProviders.queue, read: queueUsage },
    objectStore: {
      provider: diagnosticProviders.objectStore,
      read: async () => {
        const sample = await objectStoreUsage();
        const summary = storageInventory.peekSummary();
        return {
          ...sample,
          metrics: [
            ...sample.metrics,
            {
              key: "objects",
              label: "对象数量（清单快照）",
              value: summary?.objectFileCount ?? null,
              unit: "count",
            },
            {
              key: "object_bytes",
              label: "对象占用（清单快照）",
              value: summary?.objectLogicalBytes ?? null,
              unit: "bytes",
            },
            {
              key: "inventory_time",
              label: "存储清单采样时间",
              value: summary?.generatedAt ?? "尚未生成",
              unit: "text",
            },
          ],
          notes: [
            ...sample.notes,
            "清单数据使用已有快照，可能滞后。需要更新对象数量时，请前往文件管理 → 存储空间重新扫描；该面板不会触发全量扫描。",
          ],
        };
      },
    },
  });
  return {
    infrastructureCheck: (await import("../../server/platform-infrastructure-check"))
      .checkPlatformInfrastructure,
    runtimeArchiveCache: new RuntimeArchiveCache({
      dataDirectory: config.dataDirectory,
      now: () => clock.now().getTime(),
      fetch,
    }),
    diagnostics,
    infrastructureUsage,
    databaseReady,
    clock,
    config,
    configurationStore,
    platformNodes,
    nodeLogs,
    logDatabases,
    logArchives: new LogArchiveService(logArchiveRepository, clock, { next: () => uuidV7() }),
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
    ddtAssociations: new DdtAssociationTransferService(
      ddtRepository,
      {
        parse: async (content, fileName) => {
          if (!dispatcher?.parseFile)
            throw new DomainError("PLATFORM_BUSY", "配置表格解析服务尚未就绪，请稍后重试。");
          return parsedDdtAssociationImportSchema.parse(
            await dispatcher.parseFile("parse-ddt-associations", { content, fileName }),
          );
        },
      },
      clock,
      ids,
    ),
    ddtSrTags: new DdtSrTagService(srTagRepository, clock, ids),
    ddtSrTagImports: new DdtSrTagImportService(
      srTagRepository,
      isolatedSrTagSpreadsheets(
        { parse: async (content, fileName) => parseSrTagSpreadsheet(content, fileName) },
        dispatcher,
      ),
      clock,
      ids,
    ),
    ddtImports,
    ddtDebug,
    ddtChanges,
    projectStructures,
    versionCopies,
    storageInventory,
    readStorageInventory: createStorageInventoryReader({
      local: storageInventory,
      ...(platformNodes && config.mode === "full" && config.nodeId
        ? { nodeId: config.nodeId, nodes: platformNodes }
        : {}),
    }),
    executionCaseEntries: (
      batchId: string,
      keys: readonly import("@autoforge/application").ExecutionCasePageKey[],
    ) => batches.readCasePageEntries(batchId, keys),
    singleCaseExecutionEntries: (batchIds: readonly string[]) =>
      batches.readSingleCaseExecutionEntries(batchIds),
    executionBatchPage: (input: import("@autoforge/application").RunBatchListQuery) =>
      readBatchPage(batches, readModels, input),
    executionOverview: (batchId: string, projectIds?: readonly string[]) =>
      readExecutionOverview(batches, readModels, batchId, projectIds),
    executionExceptions: (input: Parameters<typeof readExecutionExceptions>[1]) =>
      readExecutionExceptions(batches, input),
    concurrencyDiagnostics: new ConcurrencyDiagnosticsService(batches, clock, () => {
      const scheduler = configurationStore.readScheduler();
      return {
        thresholds: {
          maximumCpuUtilizationPercent: scheduler.maximumCpuUtilizationPercent,
          maximumMemoryUtilizationPercent: scheduler.maximumMemoryUtilizationPercent,
          memoryAdmissionMode: scheduler.memoryAdmissionMode,
          maximumLoadPerCpu: scheduler.maximumLoadPerCpu,
        },
        metricsMaximumAgeSeconds: scheduler.metricsMaximumAgeSeconds,
        projectMaximumConcurrency: scheduler.projectMaximumConcurrency,
      };
    }),
    executionExceptionExport: (input: Parameters<typeof prepareExecutionExceptionExport>[1]) =>
      prepareExecutionExceptionExport(batches, input),
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
    publicExecutionAccess,
    publicSuiteExecutions: new PublicSuiteExecutionService(
      publicSuiteExecutionRepository,
      suites,
      identities,
      projectStructuresRepository,
      runBatches,
      executionControl,
      publicExecutionAccess,
      clock,
    ),
    runBatchExport,
    publicStatistics,
    dashboardSnapshots,
    readModels,
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
  operationName: string,
  operation: () => Promise<void>,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await operation();
    } catch (error) {
      const context = runtimeDiagnosticContext(error, { operation: operationName });
      runtimePriority().report(
        isRuntimeDatabaseContention(context) ? "database_busy" : "background_refresh",
        context,
      );
      workerLogger.error("periodic platform operation failed", {
        ...context,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
    await abortableDelay(signal, intervalMs);
  }
}

function abortableDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
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
