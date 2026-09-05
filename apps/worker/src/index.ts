import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  CaseSourceService,
  DdtImportService,
  DashboardSnapshotService,
  ImportTestNgJarService,
  JobWorker,
  PlatformOperationsService,
  RunBatchSchedulingService,
  WebhookNotificationService,
  type WorkerLogger,
} from "@autoforge/application";
import {
  createAttemptLogStore,
  createPostgresDatabase,
  NodeAttemptLogStore,
  createNodeLogTransport,
  PostgresCaseCatalogRepository,
  PostgresCaseSuiteRepository,
  PostgresDdtRepository,
  PostgresDashboardSnapshotRepository,
  PostgresRunBatchRepository,
  PostgresRunnerRepository,
  PostgresPlatformOperationsRepository,
  PostgresWebhookRepository,
} from "@autoforge/db/postgres";
import { parseDdtUpload } from "@autoforge/ddt-import";
import { uuidV7 } from "@autoforge/ids";
import { MinioObjectStore } from "@autoforge/object-store/minio";
import { JetStreamJobQueue } from "@autoforge/queue/jetstream";
import { PostgresOutboxRelay } from "@autoforge/queue/outbox";
import { connect } from "nats";
import { TestNgJarDiscovery } from "@autoforge/testng-discovery";

import { loadWorkerConfig } from "./config";
import { closeServer, startHealthServer } from "./health-server";
import { logger } from "./logger";
import { runWithTransientRecovery } from "./transient-recovery";

const config = loadWorkerConfig();
const shutdown = new AbortController();
let fatalError: unknown;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort(new Error(`Received ${signal}.`)));
}

const database = createPostgresDatabase({
  connectionString: config.databaseUrl,
  migrationsFolder: config.migrationsFolder,
  poolMax: config.databasePoolMax,
});
database.pool.on("error", (error) => {
  // PostgreSQL reports a lost idle socket through Pool's error event. The pool
  // evicts that client and can create a replacement after the dependency recovers.
  logger.error("PostgreSQL idle connection lost", { error: error.message });
});
await database.ready;
const nats = await connect({
  servers: config.natsServers,
  ...(config.natsToken ? { token: config.natsToken } : {}),
  timeout: 5_000,
  reconnect: true,
  maxReconnectAttempts: 60,
  reconnectTimeWait: 250,
});
const queue = await JetStreamJobQueue.create(nats.jetstream(), await nats.jetstreamManager());
const clock = { now: () => new Date() };
const ids = { next: () => uuidV7() };
const runnerRepository = new PostgresRunnerRepository(database);
const batches = new RunBatchSchedulingService(
  new PostgresRunBatchRepository(database, config.caseExecutionTimeoutSeconds),
  new PostgresCaseSuiteRepository(database),
  runnerRepository,
  clock,
  ids,
  {
    maximumCpuUtilizationPercent: config.scheduling.maximumCpuUtilizationPercent,
    maximumMemoryUtilizationPercent: config.scheduling.maximumMemoryUtilizationPercent,
    maximumLoadPerCpu: config.scheduling.maximumLoadPerCpu,
  },
  config.scheduling.metricsMaximumAgeSeconds,
  undefined,
  config.scheduling.projectMaximumConcurrency,
  config.scheduling.priorityAgingIntervalMinutes,
  undefined,
  undefined,
  config.caseExecutionTimeoutSeconds * 1_000,
  config.artifactCollectionEnabled,
);
const localAttemptLogs = createAttemptLogStore(join(config.dataDirectory, "attempt-logs"));
const nodeLogs =
  config.distributed && config.nodeId
    ? new NodeAttemptLogStore(
        database,
        config.nodeId,
        localAttemptLogs,
        createNodeLogTransport(config.masterKey, config.nodeId),
        join(config.dataDirectory, "attempt-logs"),
      )
    : undefined;
if (nodeLogs) await nodeLogs.initialize(join(config.dataDirectory, "attempt-logs"));
const attemptLogs = nodeLogs ?? localAttemptLogs;
const platformOperationsRepository = new PostgresPlatformOperationsRepository(
  database,
  attemptLogs,
);
const objectStore = new MinioObjectStore(config.minio);
const platformOperations = new PlatformOperationsService(
  platformOperationsRepository,
  clock,
  ids,
  {
    issue: () => `af_api_${randomBytes(32).toString("base64url")}`,
    hash: (value) => createHash("sha256").update(value).digest("hex"),
  },
  objectStore,
);
await platformOperations.initialize();
const webhooks = new WebhookNotificationService(
  new PostgresWebhookRepository(database),
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
const catalog = new PostgresCaseCatalogRepository(database);
const dashboardSnapshots = new DashboardSnapshotService(
  new PostgresDashboardSnapshotRepository(database),
  catalog,
  platformOperationsRepository,
  clock,
);
const caseSources = new CaseSourceService(catalog, objectStore, clock, ids);
const jarImports = new ImportTestNgJarService({
  catalog,
  objectStore,
  clock,
  ids,
  discovery: new TestNgJarDiscovery({
    maxJarBytes: config.maxJarBytes,
    targetJavaVersion: config.testNgTargetJavaVersion,
  }),
});
const ddtImports = new DdtImportService(
  new PostgresDdtRepository(database),
  objectStore,
  { parseUpload: parseDdtUpload },
  clock,
  ids,
);
const jobWorker = new JobWorker(
  queue,
  {
    "dispatch-run": async (job) => {
      const batchId = job.payload.batchId;
      if (typeof batchId !== "string") throw new Error("Dispatch job batchId is invalid.");
      await batches.schedule(batchId);
    },
    "object-cleanup": caseSources.objectCleanupHandler(),
    "jar-import": jarImports.jobHandler(),
    "ddt-import": ddtImports.jobHandler(),
    "analytics-export": platformOperations.analyticsExportJobHandler(),
  },
  clock,
  {
    workerId: config.workerId,
    concurrency: config.concurrency,
    leaseDurationMs: 30_000,
    minimumPollMs: 100,
    maximumPollMs: 2_000,
  },
  logger satisfies WorkerLogger,
);
const outboxRelay = new PostgresOutboxRelay(
  database,
  queue,
  {
    workerId: `${config.workerId}-outbox`,
    leaseDurationMs: 30_000,
    pollIntervalMs: 250,
    batchSize: 100,
  },
  logger,
);
const health = {
  ready: false,
  metricsEnabled: config.metricsEnabled,
  checkDependencies: async () => {
    await Promise.all([database.pool.query("SELECT 1"), queue.ready(), objectStore.ready()]);
  },
  readMetrics: async () => {
    const depth = await queue.depth();
    return [
      "# TYPE autoforge_worker_ready gauge",
      `autoforge_worker_ready ${health.ready ? 1 : 0}`,
      "# TYPE autoforge_queue_jobs gauge",
      `autoforge_queue_jobs{state=\"available\"} ${depth.available}`,
      `autoforge_queue_jobs{state=\"leased\"} ${depth.leased}`,
      `autoforge_queue_jobs{state=\"dead_letter\"} ${depth.deadLetter}`,
      "",
    ].join("\n");
  },
};
const healthServer = await startHealthServer(config.healthPort, health);
const loops = Promise.all([
  nodeLogs
    ? runPeriodic(shutdown.signal, 60_000, () => nodeLogs.cleanupOrphans())
    : Promise.resolve(),
  runWithTransientRecovery(shutdown.signal, () => jobWorker.run(shutdown.signal), logger, {
    operationName: "job consumer",
  }),
  runWithTransientRecovery(shutdown.signal, () => outboxRelay.run(shutdown.signal), logger, {
    operationName: "outbox relay",
  }),
  runPeriodic(shutdown.signal, 30_000, async () => {
    await platformOperations.triggerDueSchedules(async (schedule) => {
      const batch = await batches.create({
        suiteId: schedule.suiteId,
      });
      return batch.id;
    });
    await platformOperations.generateNotifications();
    await webhooks.dispatchDue(`${config.workerId}-webhooks`);
    await platformOperationsRepository.rebuildAnalyticsFacts(1_000);
  }),
  runPeriodic(shutdown.signal, config.dashboardRefreshIntervalMs, async () => {
    await dashboardSnapshots.refreshTracked();
  }),
  runPeriodic(shutdown.signal, 3_600_000, async () => {
    await platformOperations.runRetentionCycle();
  }),
]).catch((error: unknown) => {
  fatalError = error;
  shutdown.abort(error);
});
health.ready = true;
logger.info("AutoForge worker ready", {
  workerId: config.workerId,
  concurrency: config.concurrency,
  healthPort: config.healthPort,
  metricsEnabled: config.metricsEnabled,
});

await waitForAbort(shutdown.signal);
health.ready = false;
await closeServer(healthServer);
await withGracePeriod(loops, config.shutdownGraceMs, logger);
await Promise.allSettled([queue.close(), nats.drain(), database.close()]);
attemptLogs.close();
if (fatalError) throw fatalError;
logger.info("AutoForge worker stopped", { workerId: config.workerId });

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
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
      logger.error("periodic platform operation failed", {
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

async function withGracePeriod(
  operation: Promise<unknown>,
  graceMs: number,
  output: WorkerLogger,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    operation,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        output.error("worker drain deadline exceeded", { graceMs });
        resolve();
      }, graceMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}
