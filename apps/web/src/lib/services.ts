import { prioritizedExecutionControlRepository } from "./work-dispatch";
import { runtimePriority } from "./runtime-priority";
import { mkdir } from "node:fs/promises";
import { isolatedAttemptLogs } from "./isolated-attempt-logs";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { publicPlatformStatisticsSchema } from "@autoforge/contracts";
import { readBatchPage, readExecutionOverview } from "@autoforge/application";
import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import {
  AttemptLogShareService,
  RuntimeNotificationService,
  CaseDefinitionService,
  CaseSourceService,
  CaseSuiteService,
  CaseSuiteActivityService,
  DdtCaseService,
  DdtImportService,
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
  SqliteWebhookRepository,
} from "@autoforge/db/sqlite";
import { parseDdtUpload } from "@autoforge/ddt-import";
import { isolatedJarDiscovery, isolatedDdtSpreadsheets } from "./isolated-file-parsing";
import { LocalObjectStore } from "@autoforge/object-store/local";
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
  workerBackedBatchCreation,
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
  let objectStore: JarObjectStorePort;
  let jobQueue: JobQueuePort;
  let cache: CachePort;
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
      busyTimeoutMs: 25,
    });
    const attemptLogs = createAttemptLogStore(join(config.dataDirectory, "attempt-logs"));
    catalog = new SqliteCaseCatalogRepository(database);
    suites = new SqliteCaseSuiteRepository(database);
    suiteActivityRepository = new SqliteCaseSuiteActivityRepository(database);
    ddtRepository = new SqliteDdtRepository(database);
    dashboardSnapshotRepository = new SqliteDashboardSnapshotRepository(database);
    readModelRepository = new SqliteReadModelSnapshotRepository(database);
    runners = new SqliteRunnerRepository(database);
    runnerInstallationProfileRepository = new SqliteRunnerInstallationProfileRepository(database);
    runnerGroupsRepository = new SqliteRunnerGroupRepository(database);
    identities = new SqliteIdentityAccessRepository(database);
    const localExecutions = new SqliteExecutionControlRepository(
      database,
      attemptLogs,
      isolatedAttemptLogs(join(config.dataDirectory, "attempt-logs")),
    );
    executions = workerBackedExecutionControlRepository(localExecutions, dispatcher);
    failureAnalysisRepository = new SqliteFailureAnalysisRepository(database);
    batches = new SqliteRunBatchRepository(database, config.caseExecutionTimeoutSeconds);
    roundRecoveries = new SqliteRoundRecoveryRepository(database);
    attemptLogSharesRepository = new SqliteAttemptLogShareRepository(database);
    objectStore = new LocalObjectStore(config.dataDirectory);
    jobQueue = new SqliteJobQueue(database);
    cache = new MemoryCache();
    operationsRepository = new SqlitePlatformOperationsRepository(
      database,
      isolatedAttemptLogs(join(config.dataDirectory, "attempt-logs")),
    );
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
        PostgresReadModelSnapshotRepository,
        PostgresIdentityAccessRepository,
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
      | import("@autoforge/db/postgres").NodeAttemptLogStore = isolatedAttemptLogs(
      join(config.dataDirectory, "attempt-logs"),
    );
    const database = createPostgresDatabase({
      connectionString: config.databaseUrl,
      migrationsFolder: config.migrationsFolder,
      poolMax: config.databasePoolMax,
    });
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
        runtimePriority().report("database_busy");
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
      closeDatabase = async () => {
        await attemptLogs.close();
        await Promise.all([database.close(), executionDatabase.close()]);
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
      await Promise.allSettled([database.close(), executionDatabase.close()]);
      throw new Error("无法初始化 Full 模式基础设施。", { cause: error });
    }
    catalog = new PostgresCaseCatalogRepository(database);
    suites = new PostgresCaseSuiteRepository(database);
    suiteActivityRepository = new PostgresCaseSuiteActivityRepository(database);
    ddtRepository = new PostgresDdtRepository(database);
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
    executions = prioritizedExecutionControlRepository(
      new PostgresExecutionControlRepository(executionDatabase, attemptLogs),
      () => runtimePriority().beginForeground(),
    );
    failureAnalysisRepository = new PostgresFailureAnalysisRepository(database);
    batches = new PostgresRunBatchRepository(database, config.caseExecutionTimeoutSeconds);
    roundRecoveries = new PostgresRoundRecoveryRepository(database);
    attemptLogSharesRepository = new PostgresAttemptLogShareRepository(database);
    objectStore = new MinioObjectStore(config.minio);
    operationsRepository = new PostgresPlatformOperationsRepository(database, attemptLogs);
    projectStructuresRepository = new PostgresProjectStructureRepository(database);
    webhookRepository = new PostgresWebhookRepository(database);
  }
  const discovery = isolatedJarDiscovery(
    new TestNgJarDiscovery({
      maxJarBytes: config.maxJarBytes,
      targetJavaVersion: config.testNgTargetJavaVersion,
    }),
    dispatcher,
  );

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
  );
  const roundRecoveryConfigurationInspector = new RoundRecoveryConfigurationInspector(
    suites,
    jenkinsRoundRecoveryTransport,
    secretCipher,
  );
  const caseDefinitions = new CaseDefinitionService(catalog, clock, ids);
  const ddtCases = new DdtCaseService(ddtRepository, clock, ids, catalog);
  const ddtImports = new DdtImportService(
    ddtRepository,
    objectStore,
    isolatedDdtSpreadsheets({ parseUpload: parseDdtUpload }, dispatcher),
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
        maximumLoadPerCpu: config.scheduler.maximumLoadPerCpu,
      },
      config.scheduler.metricsMaximumAgeSeconds,
      { catalog, objectStore, ddt: ddtRepository },
      config.scheduler.projectMaximumConcurrency,
      config.scheduler.priorityAgingIntervalMinutes,
      projectStructuresRepository,
      runnerGroupsRepository,
      config.caseExecutionTimeoutSeconds * 1_000,
      () => configurationStore.read().limits.artifactCollectionEnabled,
    ),
    config.mode === "lite" ? dispatcher : undefined,
    dispatcher,
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
            "analytics-export": dispatcher
              ? (job, signal) => dispatcher.executeBackgroundJob(job, signal)
              : platformOperations.analyticsExportJobHandler(),
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
  const runtimeNoticeLoop = runPeriodic(scheduleAbort.signal, 5_000, () =>
    runtimeNotifications.deliverNextPage(),
  );
  const roundRecoveryLoop = runPeriodic(scheduleAbort.signal, 5_000, async () => {
    await roundRecovery.dispatchDue(`web-${process.pid}-round-recovery`);
  });
  const scheduleLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 30_000, async () => {
          if (dispatcher?.triggerDueSchedules) await dispatcher.triggerDueSchedules();
          else
            await platformOperations.triggerDueSchedules(async (schedule) => {
              const batch = await runBatches.create({
                suiteId: schedule.suiteId,
              });
              return batch.id;
            });
          if (!runtimePriority().backgroundAllowed()) return;
          if (dispatcher) await dispatcher.runPlatformMaintenance("notifications");
          else await platformOperations.generateNotifications(100);
          await webhooks.dispatchDue(`lite-web-${process.pid}-webhooks`);
        })
      : Promise.resolve();
  const nodeCleanupLoop = nodeLogs
    ? runPeriodic(scheduleAbort.signal, 60_000, async () => {
        if (runtimePriority().backgroundAllowed()) await nodeLogs!.cleanupOrphans();
      })
    : Promise.resolve();
  const retentionLoop =
    config.mode === "lite"
      ? runPeriodic(scheduleAbort.signal, 3_600_000, async () => {
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
    executionBatchPage: (input: import("@autoforge/application").RunBatchListQuery) =>
      readBatchPage(batches, readModels, input),
    executionOverview: (batchId: string, projectIds?: readonly string[]) =>
      readExecutionOverview(batches, readModels, batchId, projectIds),
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
  operation: () => Promise<void>,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await operation();
    } catch (error) {
      runtimePriority().report("background_refresh");
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
