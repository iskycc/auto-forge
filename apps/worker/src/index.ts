import { JobWorker, RunBatchSchedulingService, type WorkerLogger } from "@autoforge/application";
import {
  createPostgresDatabase,
  PostgresCaseSuiteRepository,
  PostgresExecutionEnvironmentRepository,
  PostgresRunBatchRepository,
  PostgresRunnerRepository,
} from "@autoforge/db/postgres";
import { uuidV7 } from "@autoforge/ids";
import { JetStreamJobQueue } from "@autoforge/queue/jetstream";
import { PostgresOutboxRelay } from "@autoforge/queue/outbox";
import { connect } from "nats";

import { loadWorkerConfig } from "./config";
import { closeServer, startHealthServer } from "./health-server";
import { logger } from "./logger";

const config = loadWorkerConfig();
const shutdown = new AbortController();
let fatalError: unknown;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort(new Error(`Received ${signal}.`)));
}

const database = createPostgresDatabase({
  connectionString: config.databaseUrl,
  migrationsFolder: config.migrationsFolder,
});
await database.ready;
const nats = await connect({
  servers: config.natsServers,
  timeout: 5_000,
  reconnect: true,
  maxReconnectAttempts: -1,
});
const queue = await JetStreamJobQueue.create(nats.jetstream(), await nats.jetstreamManager());
const clock = { now: () => new Date() };
const batches = new RunBatchSchedulingService(
  new PostgresRunBatchRepository(database),
  new PostgresCaseSuiteRepository(database),
  new PostgresRunnerRepository(database),
  clock,
  { next: () => uuidV7() },
  {
    maximumCpuUtilizationPercent: config.scheduling.maximumCpuUtilizationPercent,
    maximumMemoryUtilizationPercent: config.scheduling.maximumMemoryUtilizationPercent,
    maximumLoadPerCpu: config.scheduling.maximumLoadPerCpu,
  },
  config.scheduling.metricsMaximumAgeSeconds,
  new PostgresExecutionEnvironmentRepository(database),
);
const jobWorker = new JobWorker(
  queue,
  {
    "dispatch-run": async (job) => {
      const batchId = job.payload.batchId;
      if (typeof batchId !== "string") throw new Error("Dispatch job batchId is invalid.");
      await batches.schedule(batchId);
    },
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
    await Promise.all([database.pool.query("SELECT 1"), queue.ready()]);
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
const loops = Promise.all([jobWorker.run(shutdown.signal), outboxRelay.run(shutdown.signal)]).catch(
  (error: unknown) => {
    fatalError = error;
    shutdown.abort(error);
  },
);
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
if (fatalError) throw fatalError;
logger.info("AutoForge worker stopped", { workerId: config.workerId });

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
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
