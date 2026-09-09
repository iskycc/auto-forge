import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CaseSourceService,
  PlatformOperationsService,
  DdtImportService,
  ImportTestNgJarService,
  ReadModelSnapshotService,
} from "@autoforge/application";
import {
  jobEnvelopeSchema,
  createRunBatchInputSchema,
  createSingleCaseRunInputSchema,
  ddtScopeSchema,
} from "@autoforge/contracts";
import { z } from "zod";
import {
  MAXIMUM_DDT_IMPORT_QUANTITY_LIMIT,
  PlatformConfigurationStore,
} from "@autoforge/platform-config";
import { javaSourceReferenceSchema, ddtImportColumnResolutionSchema } from "@autoforge/contracts";
import { parentPort, workerData } from "node:worker_threads";

import type {
  ManagedPlatformClock,
  CaseCatalogRepository,
  CaseSuiteRepository,
  ExecutionControlRepository,
  JarObjectStorePort,
  ProjectStructureRepository,
  RunBatchRepository,
  RunnerGroupRepository,
  RunnerRepository,
} from "@autoforge/application";
import { buildAttemptCompletionEvents, RunBatchSchedulingService } from "@autoforge/application";
import {
  createLocalClock,
  SqliteDdtRepository,
  SqliteReadModelSnapshotRepository,
  SqlitePlatformOperationsRepository,
  createAttemptLogStore,
  isolatedThreadLogCompression,
  SqliteCaseCatalogRepository,
  SqliteCaseSuiteRepository,
  SqliteExecutionControlRepository,
  SqliteProjectStructureRepository,
  SqliteRunBatchRepository,
  SqliteRunnerGroupRepository,
  SqliteRunnerRepository,
  createSqliteDatabase,
  type AttemptLogStore,
  type SqliteDatabaseHandle,
} from "@autoforge/db/sqlite";
import {
  createPostgresDatabase,
  PostgresDdtRepository,
  PostgresReadModelSnapshotRepository,
  PostgresPlatformOperationsRepository,
  createPostgresClock,
  NodeAttemptLogStore,
  createNodeLogTransport,
  PostgresCaseCatalogRepository,
  PostgresCaseSuiteRepository,
  PostgresExecutionControlRepository,
  PostgresProjectStructureRepository,
  PostgresRunBatchRepository,
  PostgresRunnerGroupRepository,
  PostgresRunnerRepository,
  type PostgresDatabaseHandle,
} from "@autoforge/db/postgres";
import { isDomainError } from "@autoforge/domain";
import { uuidV7 } from "@autoforge/ids";
import { LocalObjectStore } from "@autoforge/object-store/local";
import { MinioObjectStore } from "@autoforge/object-store/minio";

import type {
  WorkRequest,
  WorkResponse,
  WorkTask,
  WorkThreadConfiguration,
  CancelWorkRequest,
} from "./work-protocol.ts";

const port = parentPort;
if (!port) throw new Error("Work thread requires a parent port.");
const configuration = workerData as WorkThreadConfiguration;
const platformConfigurationStore = new PlatformConfigurationStore(configuration.dataDirectory);

// 两个模式共享线程骨架，基础设施句柄按模式延迟构建：Full 线程不会打开
// SQLite 主库，Lite 线程不会创建 PostgreSQL 连接池。
let liteDatabase: SqliteDatabaseHandle | undefined;
let postgresDatabase: PostgresDatabaseHandle | undefined;
let scheduler: RunBatchSchedulingService | undefined;
let attemptLogs: AttemptLogStore | undefined;
let nodeLogs: NodeAttemptLogStore | undefined;
let executionControl:
  SqliteExecutionControlRepository | PostgresExecutionControlRepository | undefined;
let work = Promise.resolve();
let clock: ManagedPlatformClock;
let clockInitialization: Promise<void> | undefined;
const cancellations = new Map<number, AbortController>();

port.on("message", (request: WorkRequest | CancelWorkRequest) => {
  if ("cancel" in request) {
    cancellations.get(request.id)?.abort(new Error("Background work was cancelled."));
    return;
  }
  cancellations.set(request.id, new AbortController());
  // Full 模式的数据库客户端支持并发事务，线程内并行处理以保留 PostgreSQL
  // 的服务端并行度；Lite 的同步 SQLite 写入保持串行队列语义。
  if (configuration.mode === "full" && !configuration.prioritySignal) {
    void processRequest(request);
    return;
  }
  work = work.then(() => processRequest(request));
});

async function processRequest(request: WorkRequest): Promise<void> {
  try {
    const value = await execute(request.task, cancellations.get(request.id)!.signal);
    port!.postMessage({ id: request.id, ok: true, value } satisfies WorkResponse);
  } catch (error) {
    port!.postMessage({
      id: request.id,
      ok: false,
      error: serializedError(error),
    } satisfies WorkResponse);
  } finally {
    cancellations.delete(request.id);
  }
}

async function execute(task: WorkTask, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (task.kind === "parse-file") return parseFile(task);
  clockInitialization ??= initializeClock().catch((error: unknown) => {
    clockInitialization = undefined;
    throw error;
  });
  await clockInitialization;
  clock.now();
  switch (task.kind) {
    case "create-batch":
      return schedulingService().create(createRunBatchInputSchema.parse(task.input));
    case "create-single-ddt-case": {
      const { scope, caseId, input } = z
        .object({
          scope: ddtScopeSchema,
          caseId: z.string().trim().min(1).max(512),
          input: createSingleCaseRunInputSchema,
        })
        .parse(task.input);
      return schedulingService().createSingleDdtCase(scope, caseId, input);
    }
    case "trigger-schedules":
      return platformOperations().triggerDueSchedules(
        async (schedule) => (await schedulingService().create({ suiteId: schedule.suiteId })).id,
      );
    case "background-job": {
      while (!backgroundAllowed()) await delay(100, undefined, { signal });
      signal.throwIfAborted();
      return executeBackgroundJob(task.job, signal);
    }
    case "warmup": {
      // 启动预热：提前完成数据库句柄构建、迁移校验、连接池预热与调度协作者
      // 装配，避免首个真实任务（通常是 Runner 心跳触发的补位调度）承担冷启动。
      if (configuration.mode === "full") await postgresHandle().ready;
      else sqliteHandle();
      schedulingService();
      executionRepository();
      return null;
    }
    case "schedule-batch":
      return schedulingService().schedule(task.batchId);
    case "schedule-runner":
      return schedulingService().scheduleForRunner(
        task.runnerId,
        task.batchLimit,
        task.liveAvailableSlots,
      );
    case "claim-assignments":
      return executionRepository().claim(
        task.input as Parameters<ExecutionControlRepository["claim"]>[0],
      );
    case "platform-maintenance": {
      if (!backgroundAllowed()) return false;
      if (task.operation === "orphan-logs") {
        const logs = configuration.mode === "full" ? fullLogStore() : logStore();
        if (logs instanceof NodeAttemptLogStore) await logs.cleanupOrphans();
        return true;
      }
      const operations = platformOperations();
      if (task.operation === "notifications") await operations.generateNotifications(100);
      else await operations.runRetentionCycle(100);
      return true;
    }
    case "reconcile-attempts":
      return executionRepository().reconcile(
        task.input as Parameters<ExecutionControlRepository["reconcile"]>[0],
      );
    case "renew-lease":
      return executionRepository().renewLease(
        task.input as Parameters<ExecutionControlRepository["renewLease"]>[0],
      );
    case "complete-attempt": {
      // 完成事务内联调度事件：闭包无法跨线程序列化，用共享纯函数在工作线程
      // 内重建，事件内容与主线程路径完全一致。
      const completionInput = task.input as Parameters<
        ExecutionControlRepository["completeAttempt"]
      >[0];
      return executionRepository().completeAttempt(completionInput, (context, retryScheduled) =>
        buildAttemptCompletionEvents(
          { nextId: () => uuidV7(), now: () => clock.now().toISOString() },
          completionInput.attemptId,
          context,
          completionInput.result,
          retryScheduled,
        ),
      );
    }
    case "declare-artifacts":
      return executionRepository().declareArtifacts(
        task.input as Parameters<ExecutionControlRepository["declareArtifacts"]>[0],
      );
    case "recover-expired":
      return executionRepository().recoverExpired(
        task.input as Parameters<ExecutionControlRepository["recoverExpired"]>[0],
      );
    case "resolve-attempt-contexts":
      return executionRepository().resolveAttemptSchedulingContexts(task.attemptIds);
    case "terminate-batch":
      return executionRepository().terminateBatch(
        task.input as Parameters<ExecutionControlRepository["terminateBatch"]>[0],
      );
    case "append-attempt-log-chunks":
      return executionRepository().appendLogChunks(
        task.input as Parameters<ExecutionControlRepository["appendLogChunks"]>[0],
      );
  }
}

async function parseFile(task: Extract<WorkTask, { kind: "parse-file" }>): Promise<unknown> {
  if (task.operation === "parse-ddt") {
    const { parseDdtUpload } = await import("@autoforge/ddt-import");
    const input = z
      .object({
        fileName: z.string(),
        mediaType: z.string(),
        content: z.instanceof(Uint8Array),
        columnResolutions: ddtImportColumnResolutionSchema
          .omit({ uploadIndex: true })
          .array()
          .optional(),
        parseLimits: z
          .object({
            maximumZipSpreadsheets: z.number().int().min(1).max(MAXIMUM_DDT_IMPORT_QUANTITY_LIMIT),
          })
          .optional(),
      })
      .parse(task.input);
    return parseDdtUpload(
      {
        fileName: input.fileName,
        mediaType: input.mediaType,
        content: input.content,
        ...(input.columnResolutions ? { columnResolutions: input.columnResolutions } : {}),
      },
      input.parseLimits,
    );
  }
  const { TestNgJarDiscovery } = await import("@autoforge/testng-discovery");
  const discovery = new TestNgJarDiscovery(configuration.imports);
  const input = z
    .object({
      fileName: z.string().optional(),
      content: z.instanceof(Uint8Array),
      reference: javaSourceReferenceSchema.optional(),
    })
    .parse(task.input);
  return task.operation === "inspect-jar"
    ? discovery.inspect(input.fileName ?? "upload.jar", input.content)
    : discovery.readSource(input.content, input.reference);
}

function backgroundAllowed(): boolean {
  return (
    !configuration.prioritySignal ||
    Atomics.load(new Int32Array(configuration.prioritySignal), 0) === 0
  );
}

function platformOperations(): PlatformOperationsService {
  const repository =
    configuration.mode === "lite"
      ? new SqlitePlatformOperationsRepository(sqliteHandle(), logStore())
      : new PostgresPlatformOperationsRepository(postgresHandle(), fullLogStore());
  return new PlatformOperationsService(
    repository,
    clock,
    { next: () => uuidV7() },
    {
      issue: () => randomBytes(32).toString("base64url"),
      hash: (value) => createHash("sha256").update(value).digest("hex"),
    },
    schedulingCollaborators().objectStore,
  );
}

async function executeBackgroundJob(input: unknown, signal: AbortSignal): Promise<void> {
  const job = jobEnvelopeSchema.parse(input);
  const { catalog, objectStore } = schedulingCollaborators();
  const ids = { next: () => uuidV7() };
  const snapshots = new ReadModelSnapshotService(
    configuration.mode === "lite"
      ? new SqliteReadModelSnapshotRepository(sqliteHandle())
      : new PostgresReadModelSnapshotRepository(postgresHandle()),
    clock,
  );
  switch (job.kind) {
    case "object-cleanup":
      return new CaseSourceService(catalog, objectStore, clock, ids).objectCleanupHandler()(
        job,
        signal,
      );
    case "analytics-export":
      return platformOperations().analyticsExportJobHandler()(job, signal);
    case "jar-import": {
      const { TestNgJarDiscovery } = await import("@autoforge/testng-discovery");
      if (!configuration.imports)
        throw new Error("Background JAR import configuration is missing.");
      return new ImportTestNgJarService({
        catalog,
        objectStore,
        clock,
        ids,
        readModelInvalidation: snapshots,
        discovery: new TestNgJarDiscovery(configuration.imports),
      }).jobHandler()(job, signal);
    }
    case "ddt-import": {
      const { parseDdtUpload } = await import("@autoforge/ddt-import");
      const repository =
        configuration.mode === "lite"
          ? new SqliteDdtRepository(sqliteHandle())
          : new PostgresDdtRepository(postgresHandle());
      return new DdtImportService(
        repository,
        objectStore,
        { parseUpload: parseDdtUpload },
        clock,
        ids,
        snapshots,
        currentDdtImportLimits,
      ).jobHandler()(job, signal);
    }
    default:
      throw new Error(`Job ${job.kind} is not a background maintenance operation.`);
  }
}

type SchedulingCollaborators = {
  catalog: CaseCatalogRepository;
  suites: CaseSuiteRepository;
  runners: RunnerRepository;
  batches: RunBatchRepository;
  projectStructures: ProjectStructureRepository;
  runnerGroups: RunnerGroupRepository;
  objectStore: JarObjectStorePort;
};

function schedulingService(): RunBatchSchedulingService {
  if (!scheduler) {
    const collaborators = schedulingCollaborators();
    scheduler = new RunBatchSchedulingService(
      collaborators.batches,
      collaborators.suites,
      collaborators.runners,
      clock,
      { next: () => uuidV7() },
      {
        maximumCpuUtilizationPercent: configuration.scheduler.maximumCpuUtilizationPercent,
        maximumMemoryUtilizationPercent: configuration.scheduler.maximumMemoryUtilizationPercent,
        maximumLoadPerCpu: configuration.scheduler.maximumLoadPerCpu,
      },
      configuration.scheduler.metricsMaximumAgeSeconds,
      {
        catalog: collaborators.catalog,
        objectStore: collaborators.objectStore,
        ddt:
          configuration.mode === "lite"
            ? new SqliteDdtRepository(sqliteHandle())
            : new PostgresDdtRepository(postgresHandle()),
      },
      configuration.scheduler.projectMaximumConcurrency,
      configuration.scheduler.priorityAgingIntervalMinutes,
      collaborators.projectStructures,
      collaborators.runnerGroups,
      configuration.caseExecutionTimeoutSeconds * 1_000,
      () => platformConfigurationStore.read().limits.artifactCollectionEnabled,
    );
  }
  return scheduler;
}

function currentDdtImportLimits() {
  const limits = platformConfigurationStore.read().limits;
  return {
    maximumUploadFiles: limits.ddtImportFileLimit,
    maximumZipSpreadsheets: limits.ddtImportZipSpreadsheetLimit,
  };
}

function schedulingCollaborators(): SchedulingCollaborators {
  if (configuration.mode === "full") {
    const database = postgresHandle();
    return {
      catalog: new PostgresCaseCatalogRepository(database),
      suites: new PostgresCaseSuiteRepository(database),
      runners: new PostgresRunnerRepository(database),
      batches: new PostgresRunBatchRepository(database, configuration.caseExecutionTimeoutSeconds),
      projectStructures: new PostgresProjectStructureRepository(database),
      runnerGroups: new PostgresRunnerGroupRepository(database),
      objectStore: new MinioObjectStore(fullSettings().minio),
    };
  }
  const database = sqliteHandle();
  return {
    catalog: new SqliteCaseCatalogRepository(database),
    suites: new SqliteCaseSuiteRepository(database),
    runners: new SqliteRunnerRepository(database),
    batches: new SqliteRunBatchRepository(database, configuration.caseExecutionTimeoutSeconds),
    projectStructures: new SqliteProjectStructureRepository(database),
    runnerGroups: new SqliteRunnerGroupRepository(database),
    objectStore: new LocalObjectStore(configuration.dataDirectory),
  };
}

function executionRepository():
  SqliteExecutionControlRepository | PostgresExecutionControlRepository {
  if (!executionControl) {
    executionControl =
      configuration.mode === "full"
        ? new PostgresExecutionControlRepository(postgresHandle(), fullLogStore())
        : new SqliteExecutionControlRepository(sqliteHandle(), logStore());
  }
  return executionControl;
}

function sqliteHandle(): SqliteDatabaseHandle {
  const sqlite = configuration.sqlite;
  if (!sqlite) throw new Error("Work thread is missing SQLite configuration.");
  liteDatabase ??= createSqliteDatabase({
    databasePath: sqlite.databasePath,
    migrationsFolder: configuration.migrationsFolder,
    ...(configuration.prioritySignal ? { busyTimeoutMs: 25 } : {}),
  });
  return liteDatabase;
}

function postgresHandle(): PostgresDatabaseHandle {
  const settings = fullSettings();
  postgresDatabase ??= createPostgresDatabase({
    connectionString: settings.databaseUrl,
    migrationsFolder: configuration.migrationsFolder,
    poolMax: settings.databasePoolMax,
  });
  return postgresDatabase;
}

function fullSettings(): NonNullable<WorkThreadConfiguration["full"]> {
  if (!configuration.full) throw new Error("Work thread is missing Full configuration.");
  return configuration.full;
}

function fullLogStore(): AttemptLogStore | NodeAttemptLogStore {
  const settings = fullSettings();
  if (!settings.nodeId || !settings.masterKey) return logStore();
  nodeLogs ??= new NodeAttemptLogStore(
    postgresHandle(),
    settings.nodeId,
    logStore(),
    createNodeLogTransport(settings.masterKey, settings.nodeId, clock),
    configuration.attemptLogsDirectory,
    clock,
  );
  return nodeLogs;
}

function logStore(): AttemptLogStore {
  attemptLogs ??= createAttemptLogStore(
    configuration.attemptLogsDirectory,
    isolatedThreadLogCompression,
  );
  return attemptLogs;
}

function serializedError(error: unknown): Extract<WorkResponse, { ok: false }>["error"] {
  if (isDomainError(error)) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      details: error.details,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
      ...("code" in error &&
      error.code === "DDT_DUPLICATE_COLUMNS" &&
      "fileName" in error &&
      "conflicts" in error
        ? { details: { fileName: error.fileName, conflicts: error.conflicts } }
        : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: "Work thread failed with a non-Error value." };
}

process.once("exit", () => {
  attemptLogs?.close();
  liteDatabase?.close();
  // 进程退出事件循环已近终止，连接池尽力关闭即可；未完成的套接字随进程回收。
  void postgresDatabase?.close();
});

async function initializeClock(): Promise<void> {
  clock =
    configuration.mode === "lite"
      ? createLocalClock()
      : await createPostgresClock(postgresHandle(), (error) => {
          process.stderr.write(
            `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "Work thread clock synchronization failed", error: error instanceof Error ? error.message : "Unknown clock error" })}\n`,
          );
        });
}
