import { monitorEventLoopDelay } from "node:perf_hooks";
import { detectRuntimeResources } from "@autoforge/platform-config/runtime-resources";
import { BackgroundWorkerPool } from "../../web/server/worker-pool";
import { ReadModelWorkerHost } from "../../web/server/read-model-worker-host";
import { backgroundResourcePlan } from "../../web/src/lib/worker-sizing";
import { runtimePriority } from "../../web/src/lib/runtime-priority";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  JobWorker,
  PlatformOperationsService,
  RuntimeNotificationService,
  RunBatchSchedulingService,
  WebhookNotificationService,
  type WorkerLogger,
} from "@autoforge/application";
import {
  createAttemptLogStore,
  createPostgresDatabase,
  createPostgresClock,
  NodeAttemptLogStore,
  createNodeLogTransport,
  PostgresCaseSuiteRepository,
  PostgresRunBatchRepository,
  PostgresRunnerRepository,
  PostgresPlatformOperationsRepository,
  PostgresWebhookRepository,
  PostgresIdentityAccessRepository,
} from "@autoforge/db/postgres";
import { uuidV7 } from "@autoforge/ids";
import { MinioObjectStore } from "@autoforge/object-store/minio";
import { JetStreamJobQueue } from "@autoforge/queue/jetstream";
import { PostgresOutboxRelay } from "@autoforge/queue/outbox";
import { connect } from "nats";

import { loadWorkerConfig } from "./config";
import { closeServer, startHealthServer } from "./health-server";
import { logger } from "./logger";
import { runWithTransientRecovery } from "./transient-recovery";

const config = loadWorkerConfig();
const resources = detectRuntimeResources();
const resourcePlan = backgroundResourcePlan(resources, config.concurrency, config.databasePoolMax);
runtimePriority().configure(Math.max(1, Math.floor(resources.cpuCapacity) - 1));
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
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let cpuSample = process.cpuUsage();
let sampledAt = performance.now();
const pressureMonitor = setInterval(() => {
  const now = performance.now();
  const cpu = process.cpuUsage(cpuSample);
  runtimePriority().observeEventLoopDelay(eventLoopDelay.max / 1_000_000);
  runtimePriority().observeResources(
    (cpu.user + cpu.system) / ((now - sampledAt) * 1_000 * resources.cpuCapacity),
    process.availableMemory() / resources.memoryCapacityBytes,
  );
  cpuSample = process.cpuUsage();
  sampledAt = now;
  eventLoopDelay.reset();
}, 250);
pressureMonitor.unref();
const canRefresh = () =>
  !shutdown.signal.aborted &&
  database.pool.waitingCount === 0 &&
  runtimePriority().backgroundAllowed();
const nats = await connect({
  servers: config.natsServers,
  ...(config.natsToken ? { token: config.natsToken } : {}),
  timeout: 5_000,
  reconnect: true,
  maxReconnectAttempts: 60,
  reconnectTimeWait: 250,
});
const queue = await JetStreamJobQueue.create(nats.jetstream(), await nats.jetstreamManager());
const clock = await createPostgresClock(database, (error) => {
  logger.error("Platform clock synchronization failed", {
    error: error instanceof Error ? error.message : "Unknown clock error",
  });
});
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
        createNodeLogTransport(config.masterKey, config.nodeId, clock),
        join(config.dataDirectory, "attempt-logs"),
        clock,
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
const backgroundPool = new BackgroundWorkerPool(
  {
    mode: "full",
    imports: { maxJarBytes: config.maxJarBytes, targetJavaVersion: config.testNgTargetJavaVersion },
    migrationsFolder: config.migrationsFolder,
    attemptLogsDirectory: join(config.dataDirectory, "attempt-logs"),
    dataDirectory: config.dataDirectory,
    caseExecutionTimeoutSeconds: config.caseExecutionTimeoutSeconds,
    artifactCollectionEnabled: config.artifactCollectionEnabled(),
    scheduler: config.scheduling,
    full: {
      ...(config.distributed && config.nodeId
        ? { nodeId: config.nodeId, masterKey: config.masterKey }
        : {}),
      databaseUrl: config.databaseUrl,
      databasePoolMax: config.databasePoolMax,
      minio: config.minio,
    },
  },
  {
    lanes: resourcePlan.maintenanceLanes,
    heapMb: resourcePlan.workerHeapMb,
    shutdownGraceMs: config.shutdownGraceMs,
  },
);
const readModelWorkers = Array.from(
  { length: resourcePlan.snapshotLanes },
  (_, index) =>
    new ReadModelWorkerHost(
      {
        mode: "full",
        databaseUrl: config.databaseUrl,
        migrationsFolder: config.migrationsFolder,
        poolMax: 1,
        heapMb: resourcePlan.workerHeapMb,
        refreshFacts: index === 0,
      },
      (error) => {
        runtimePriority().report("background_refresh");
        logger.error("Background snapshot thread failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    ),
);
const runtimeNotifications = new RuntimeNotificationService(
  new PostgresIdentityAccessRepository(database),
  platformOperationsRepository,
  runtimePriority(),
  clock,
  config.workerId,
);
const workerOptions = {
  concurrency: config.concurrency,
  leaseDurationMs: 30_000,
  minimumPollMs: 100,
  maximumPollMs: 2_000,
};
const dispatchWorker = new JobWorker(
  queue,
  {
    "dispatch-run": async (job) => {
      const batchId = job.payload.batchId;
      if (typeof batchId !== "string") throw new Error("Dispatch job batchId is invalid.");
      const finish = runtimePriority().beginForeground();
      try {
        await batches.schedule(batchId);
      } finally {
        finish();
      }
    },
  },
  clock,
  { ...workerOptions, workerId: config.workerId, workClass: "execution" },
  logger satisfies WorkerLogger,
);
const handleBackgroundJob = async (
  job: Parameters<BackgroundWorkerPool["executeBackgroundJob"]>[0],
  signal: AbortSignal,
) => {
  await backgroundPool.executeBackgroundJob(job, signal);
};
const backgroundWorker = new JobWorker(
  queue,
  {
    "object-cleanup": handleBackgroundJob,
    "jar-import": handleBackgroundJob,
    "ddt-import": handleBackgroundJob,
    "analytics-export": handleBackgroundJob,
  },
  clock,
  {
    ...workerOptions,
    concurrency: resourcePlan.maintenanceLanes,
    workerId: `${config.workerId}-background`,
    workClass: "background",
    canClaim: canRefresh,
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
  clock,
);
const health = {
  ready: false,
  metricsEnabled: config.metricsEnabled,
  checkDependencies: async () => {
    clock.now();
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
    ? runPeriodic(shutdown.signal, 60_000, async () => {
        if (canRefresh()) await backgroundPool.runPlatformMaintenance("orphan-logs");
      })
    : Promise.resolve(),
  runWithTransientRecovery(shutdown.signal, () => dispatchWorker.run(shutdown.signal), logger, {
    operationName: "dispatch consumer",
  }),
  runWithTransientRecovery(shutdown.signal, () => backgroundWorker.run(shutdown.signal), logger, {
    operationName: "background consumer",
  }),
  runPeriodic(shutdown.signal, 5_000, () => runtimeNotifications.deliverNextPage()),
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
    if (!canRefresh()) return;
    await backgroundPool.runPlatformMaintenance("notifications");
    await webhooks.dispatchDue(`${config.workerId}-webhooks`);
  }),
  runPeriodic(shutdown.signal, 3_600_000, async () => {
    if (canRefresh()) await backgroundPool.runPlatformMaintenance("retention");
  }),
]).catch((error: unknown) => {
  fatalError = error;
  shutdown.abort(error);
});
health.ready = true;
logger.info("AutoForge worker ready", {
  ...resources,
  ...resourcePlan,
  workerId: config.workerId,
  concurrency: config.concurrency,
  healthPort: config.healthPort,
  metricsEnabled: config.metricsEnabled,
});

await waitForAbort(shutdown.signal);
health.ready = false;
await closeServer(healthServer);
await withGracePeriod(loops, config.shutdownGraceMs, logger);
clearInterval(pressureMonitor);
eventLoopDelay.disable();
await clock.close();
await Promise.allSettled([
  queue.close(),
  nats.drain(),
  database.close(),
  backgroundPool.close(),
  ...readModelWorkers.map((worker) => worker.close()),
]);
await attemptLogs.close();
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
      runtimePriority().report("background_refresh");
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
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
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
