import { parentPort, workerData } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AnalyticsFactRefresh } from "./analytics-fact-refresh.ts";
import {
  CaseSuiteActivityService,
  DashboardSnapshotService,
  ReadModelSnapshotWorker,
  createReadModelBuilder,
} from "@autoforge/application";

const configuration = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("lite"),
      databasePath: z.string().min(1),
      migrationsFolder: z.string().min(1),
      refreshFacts: z.boolean().default(true),
      buildInitial: z.boolean().default(false),
    }),
    z.object({
      mode: z.literal("full"),
      databaseUrl: z.string().min(1),
      migrationsFolder: z.string().min(1),
      refreshFacts: z.boolean().default(true),
      buildInitial: z.boolean().default(false),
      poolMax: z.number().int().positive().default(2),
    }),
  ])
  .parse(workerData);

const priority = new Int32Array(z.instanceof(SharedArrayBuffer).parse(workerData.prioritySignal));
const canRefresh = () => Atomics.load(priority, 0) === 0 && !shutdown.signal.aborted;
const shutdown = new AbortController();
parentPort?.on("message", () => shutdown.abort());
const resources = await initialize();
const builder = createReadModelBuilder({
  batches: resources.batches,
  suites: resources.suites,
  statistics: resources.statistics,
  catalog: resources.catalog,
  ddt: resources.ddt,
  operations: resources.operations,
  analysis: resources.analysis,
  clock: resources.clock,
  dashboard: new DashboardSnapshotService(
    resources.dashboard,
    resources.catalog,
    resources.operations,
    resources.clock,
  ),
  suiteActivity: new CaseSuiteActivityService(
    resources.activity,
    resources.suites,
    resources.batches,
    resources.clock,
  ),
});
const worker = new ReadModelSnapshotWorker(
  resources.snapshots,
  builder,
  resources.clock,
  { next: randomUUID },
  reportRefreshError,
  canRefresh,
  () => configuration.buildInitial && Atomics.load(priority, 1) === 0 && !shutdown.signal.aborted,
  resources.isResourceContention,
);
let completedCycles = 0;
const factRefresh = new AnalyticsFactRefresh(
  () => resources.operations.rebuildAnalyticsFacts(100),
  reportRefreshError,
);
try {
  while (!shutdown.signal.aborted) {
    let refreshed = false;
    try {
      if (configuration.refreshFacts && canRefresh()) await factRefresh.refreshIfDue();
      refreshed = await worker.refreshOne();
      completedCycles += 1;
      if (completedCycles % 60 === 0) await worker.cleanup();
    } catch (error) {
      reportRefreshError(error);
    }
    await delay(refreshed ? 50 : configuration.buildInitial ? 250 : 1_000, undefined, {
      signal: shutdown.signal,
    }).catch((error: unknown) => {
      if (!shutdown.signal.aborted) throw error;
    });
  }
} finally {
  await resources.clock.close();
  await resources.close();
  parentPort?.close();
}

async function initialize() {
  if (configuration.mode === "lite") {
    const adapters = await import("@autoforge/db/sqlite");
    const database = adapters.createSqliteDatabase({
      databasePath: configuration.databasePath,
      migrationsFolder: configuration.migrationsFolder,
      busyTimeoutMs: 25,
    });
    return {
      statistics: new adapters.SqlitePlatformStatisticsRepository(database),
      snapshots: new adapters.SqliteReadModelSnapshotRepository(database),
      isResourceContention: adapters.isDatabaseLockContentionError,
      ddt: new adapters.SqliteDdtRepository(database),
      catalog: new adapters.SqliteCaseCatalogRepository(database),
      operations: new adapters.SqlitePlatformOperationsRepository(database),
      analysis: new adapters.SqliteFailureAnalysisRepository(database),
      dashboard: new adapters.SqliteDashboardSnapshotRepository(database),
      activity: new adapters.SqliteCaseSuiteActivityRepository(database),
      suites: new adapters.SqliteCaseSuiteRepository(database),
      batches: new adapters.SqliteRunBatchRepository(database),
      clock: adapters.createLocalClock(),
      close: async () => database.close(),
    };
  }
  const adapters = await import("@autoforge/db/postgres");
  const database = adapters.createPostgresDatabase({
    connectionString: configuration.databaseUrl,
    migrationsFolder: configuration.migrationsFolder,
    poolMax: configuration.poolMax,
    statementTimeoutMs: 2_000,
    lockTimeoutMs: 50,
  });
  try {
    await database.ready;
    return {
      statistics: new adapters.PostgresPlatformStatisticsRepository(database),
      snapshots: new adapters.PostgresReadModelSnapshotRepository(database),
      isResourceContention: adapters.isDatabaseLockContentionError,
      ddt: new adapters.PostgresDdtRepository(database),
      catalog: new adapters.PostgresCaseCatalogRepository(database),
      operations: new adapters.PostgresPlatformOperationsRepository(database),
      analysis: new adapters.PostgresFailureAnalysisRepository(database),
      dashboard: new adapters.PostgresDashboardSnapshotRepository(database),
      activity: new adapters.PostgresCaseSuiteActivityRepository(database),
      suites: new adapters.PostgresCaseSuiteRepository(database),
      batches: new adapters.PostgresRunBatchRepository(database),
      clock: await adapters.createPostgresClock(database, reportError),
      close: () => database.close(),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

function reportRefreshError(error: unknown, query?: { kind: string; projectId: string }) {
  if (resources.isResourceContention(error)) {
    parentPort?.postMessage({ kind: "database_contention" });
    return;
  }
  reportError(error, query);
}

function reportError(error: unknown, query?: { kind: string; projectId: string }) {
  parentPort?.postMessage({ kind: "background_refresh" });
  process.stderr.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "Background read model refresh failed", requestId: "read-model-worker", kind: query?.kind, projectId: query?.projectId, error: (error instanceof Error ? error.message : String(error)).replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@") })}\n`,
  );
}
