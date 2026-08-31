import { parentPort, workerData } from "node:worker_threads";

import type {
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
  createAttemptLogStore,
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
} from "./work-protocol.ts";

const port = parentPort;
if (!port) throw new Error("Work thread requires a parent port.");
const configuration = workerData as WorkThreadConfiguration;

// 两个模式共享线程骨架，基础设施句柄按模式延迟构建：Full 线程不会打开
// SQLite 主库，Lite 线程不会创建 PostgreSQL 连接池。
let liteDatabase: SqliteDatabaseHandle | undefined;
let postgresDatabase: PostgresDatabaseHandle | undefined;
let scheduler: RunBatchSchedulingService | undefined;
let attemptLogs: AttemptLogStore | undefined;
let executionControl:
  SqliteExecutionControlRepository | PostgresExecutionControlRepository | undefined;
let work = Promise.resolve();

port.on("message", (request: WorkRequest) => {
  // Full 模式的数据库客户端支持并发事务，线程内并行处理以保留 PostgreSQL
  // 的服务端并行度；Lite 的同步 SQLite 写入保持串行队列语义。
  if (configuration.mode === "full") {
    void processRequest(request);
    return;
  }
  work = work.then(() => processRequest(request));
});

async function processRequest(request: WorkRequest): Promise<void> {
  try {
    const value = await execute(request.task);
    port!.postMessage({ id: request.id, ok: true, value } satisfies WorkResponse);
  } catch (error) {
    port!.postMessage({
      id: request.id,
      ok: false,
      error: serializedError(error),
    } satisfies WorkResponse);
  }
}

async function execute(task: WorkTask): Promise<unknown> {
  switch (task.kind) {
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
          { nextId: () => uuidV7(), now: () => new Date().toISOString() },
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
      { now: () => new Date() },
      { next: () => uuidV7() },
      {
        maximumCpuUtilizationPercent: configuration.scheduler.maximumCpuUtilizationPercent,
        maximumMemoryUtilizationPercent: configuration.scheduler.maximumMemoryUtilizationPercent,
        maximumLoadPerCpu: configuration.scheduler.maximumLoadPerCpu,
      },
      configuration.scheduler.metricsMaximumAgeSeconds,
      { catalog: collaborators.catalog, objectStore: collaborators.objectStore },
      configuration.scheduler.projectMaximumConcurrency,
      configuration.scheduler.priorityAgingIntervalMinutes,
      collaborators.projectStructures,
      collaborators.runnerGroups,
      configuration.caseExecutionTimeoutSeconds * 1_000,
      () => configuration.artifactCollectionEnabled,
    );
  }
  return scheduler;
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
        ? new PostgresExecutionControlRepository(postgresHandle(), logStore())
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

function logStore(): AttemptLogStore {
  attemptLogs ??= createAttemptLogStore(configuration.attemptLogsDirectory);
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
