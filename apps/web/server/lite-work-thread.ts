import { parentPort, workerData } from "node:worker_threads";

import { RunBatchSchedulingService } from "@autoforge/application";
import {
  createAttemptLogStore,
  createSqliteDatabase,
  SqliteCaseCatalogRepository,
  SqliteCaseSuiteRepository,
  SqliteExecutionControlRepository,
  SqliteProjectStructureRepository,
  SqliteRunBatchRepository,
  SqliteRunnerGroupRepository,
  SqliteRunnerRepository,
  type AttemptLogStore,
  type SqliteDatabaseHandle,
} from "@autoforge/db/sqlite";
import { isDomainError } from "@autoforge/domain";
import { uuidV7 } from "@autoforge/ids";
import { LocalObjectStore } from "@autoforge/object-store/local";

import type {
  LiteWorkerConfiguration,
  LiteWorkerRequest,
  LiteWorkerResponse,
  LiteWorkerTask,
} from "./lite-work-protocol.ts";

const port = parentPort;
if (!port) throw new Error("Lite work thread requires a parent port.");
const configuration = workerData as LiteWorkerConfiguration;
let database: SqliteDatabaseHandle | undefined;
let scheduler: RunBatchSchedulingService | undefined;
let attemptLogs: AttemptLogStore | undefined;
let executionControl: SqliteExecutionControlRepository | undefined;
let work = Promise.resolve();

port.on("message", (request: LiteWorkerRequest) => {
  work = work.then(() => processRequest(request));
});

async function processRequest(request: LiteWorkerRequest): Promise<void> {
  try {
    const value = await execute(request.task);
    port!.postMessage({ id: request.id, ok: true, value } satisfies LiteWorkerResponse);
  } catch (error) {
    port!.postMessage({
      id: request.id,
      ok: false,
      error: serializedError(error),
    } satisfies LiteWorkerResponse);
  }
}

async function execute(task: LiteWorkerTask): Promise<unknown> {
  switch (task.kind) {
    case "schedule-batch":
      return schedulingService().schedule(task.batchId);
    case "schedule-runner":
      return schedulingService().scheduleForRunner(task.runnerId, task.batchLimit);
    case "claim-assignments":
      return executionRepository().claim(
        task.input as Parameters<SqliteExecutionControlRepository["claim"]>[0],
      );
    case "renew-lease":
      return executionRepository().renewLease(
        task.input as Parameters<SqliteExecutionControlRepository["renewLease"]>[0],
      );
    case "complete-attempt":
      return executionRepository().completeAttempt(
        task.input as Parameters<SqliteExecutionControlRepository["completeAttempt"]>[0],
      );
    case "declare-artifacts":
      return executionRepository().declareArtifacts(
        task.input as Parameters<SqliteExecutionControlRepository["declareArtifacts"]>[0],
      );
    case "recover-expired":
      return executionRepository().recoverExpired(
        task.input as Parameters<SqliteExecutionControlRepository["recoverExpired"]>[0],
      );
    case "resolve-attempt-contexts":
      return executionRepository().resolveAttemptSchedulingContexts(task.attemptIds);
    case "terminate-batch":
      return executionRepository().terminateBatch(
        task.input as Parameters<SqliteExecutionControlRepository["terminateBatch"]>[0],
      );
    case "append-attempt-log-chunks":
      return executionRepository().appendLogChunks(
        task.input as Parameters<SqliteExecutionControlRepository["appendLogChunks"]>[0],
      );
  }
}

function schedulingService(): RunBatchSchedulingService {
  if (scheduler) return scheduler;
  const handle = databaseHandle();
  const catalog = new SqliteCaseCatalogRepository(handle);
  const suites = new SqliteCaseSuiteRepository(handle);
  const runners = new SqliteRunnerRepository(handle);
  const batches = new SqliteRunBatchRepository(handle, configuration.caseExecutionTimeoutSeconds);
  scheduler = new RunBatchSchedulingService(
    batches,
    suites,
    runners,
    { now: () => new Date() },
    { next: () => uuidV7() },
    {
      maximumCpuUtilizationPercent: configuration.scheduler.maximumCpuUtilizationPercent,
      maximumMemoryUtilizationPercent: configuration.scheduler.maximumMemoryUtilizationPercent,
      maximumLoadPerCpu: configuration.scheduler.maximumLoadPerCpu,
    },
    configuration.scheduler.metricsMaximumAgeSeconds,
    {
      catalog,
      objectStore: new LocalObjectStore(configuration.dataDirectory),
    },
    configuration.scheduler.projectMaximumConcurrency,
    configuration.scheduler.priorityAgingIntervalMinutes,
    new SqliteProjectStructureRepository(handle),
    new SqliteRunnerGroupRepository(handle),
    configuration.caseExecutionTimeoutSeconds * 1_000,
    () => configuration.artifactCollectionEnabled,
  );
  return scheduler;
}

function databaseHandle(): SqliteDatabaseHandle {
  database ??= createSqliteDatabase({
    databasePath: configuration.databasePath,
    migrationsFolder: configuration.migrationsFolder,
  });
  return database;
}

function logStore(): AttemptLogStore {
  attemptLogs ??= createAttemptLogStore(configuration.attemptLogsDirectory);
  return attemptLogs;
}

function executionRepository(): SqliteExecutionControlRepository {
  executionControl ??= new SqliteExecutionControlRepository(databaseHandle(), logStore());
  return executionControl;
}

function serializedError(error: unknown): Extract<LiteWorkerResponse, { ok: false }>["error"] {
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
  return { name: "Error", message: "Lite worker failed with a non-Error value." };
}

process.once("exit", () => {
  attemptLogs?.close();
  database?.close();
});
