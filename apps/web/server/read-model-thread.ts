import { parentPort, workerData } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
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
    }),
    z.object({
      mode: z.literal("full"),
      databaseUrl: z.string().min(1),
      migrationsFolder: z.string().min(1),
    }),
  ])
  .parse(workerData);

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
  reportError,
);
let completedCycles = 0;
try {
  while (!shutdown.signal.aborted) {
    let refreshed = false;
    try {
      refreshed = await worker.refreshOne();
      completedCycles += 1;
      if (completedCycles % 60 === 0) await worker.cleanup();
    } catch (error) {
      reportError(error);
    }
    await delay(refreshed ? 50 : 1_000, undefined, { signal: shutdown.signal }).catch(
      (error: unknown) => {
        if (!shutdown.signal.aborted) throw error;
      },
    );
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
    });
    return {
      statistics: new adapters.SqlitePlatformStatisticsRepository(database),
      snapshots: new adapters.SqliteReadModelSnapshotRepository(database),
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
    poolMax: 2,
  });
  try {
    await database.ready;
    return {
      statistics: new adapters.PostgresPlatformStatisticsRepository(database),
      snapshots: new adapters.PostgresReadModelSnapshotRepository(database),
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

function reportError(error: unknown, query?: { kind: string; projectId: string }) {
  process.stderr.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "Background read model refresh failed", requestId: "read-model-worker", kind: query?.kind, projectId: query?.projectId, error: (error instanceof Error ? error.message : String(error)).replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@") })}\n`,
  );
}
