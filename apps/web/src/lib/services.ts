import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  CaseSourceService,
  CaseSuiteService,
  ImportTestNgJarService,
  RunnerControlService,
  type CaseCatalogRepository,
  type CaseSuiteRepository,
  type JarObjectStorePort,
  type RunnerRepository,
} from "@autoforge/application";
import {
  createSqliteDatabase,
  SqliteCaseCatalogRepository,
  SqliteCaseSuiteRepository,
  SqliteRunnerRepository,
} from "@autoforge/db/sqlite";
import { LocalObjectStore } from "@autoforge/object-store/local";
import { TestNgJarDiscovery } from "@autoforge/testng-discovery";

import { loadAppConfig } from "./config";
import { MemoryRequestLimiter, RedisRequestLimiter, type RequestLimiter } from "./request-limiter";
import { uuidV7 } from "./uuid-v7";

export type PlatformServices = Awaited<ReturnType<typeof createPlatformServices>>;

type FullInfrastructure = {
  ready(): Promise<void>;
  close(): Promise<void>;
};

async function createPlatformServices() {
  const config = loadAppConfig();
  let catalog: CaseCatalogRepository;
  let suites: CaseSuiteRepository;
  let runners: RunnerRepository;
  let objectStore: JarObjectStorePort;
  let runnerRequestLimiter: RequestLimiter = new MemoryRequestLimiter();
  let fullInfrastructure: FullInfrastructure | undefined;
  if (config.mode === "lite") {
    const database = createSqliteDatabase({
      databasePath: config.databasePath,
      migrationsFolder: config.migrationsFolder,
    });
    catalog = new SqliteCaseCatalogRepository(database);
    suites = new SqliteCaseSuiteRepository(database);
    runners = new SqliteRunnerRepository(database);
    objectStore = new LocalObjectStore(config.dataDirectory);
  } else {
    const [
      {
        createPostgresDatabase,
        PostgresCaseCatalogRepository,
        PostgresCaseSuiteRepository,
        PostgresRunnerRepository,
      },
      { MinioObjectStore },
      { connect },
      { createClient },
    ] = await Promise.all([
      import("@autoforge/db/postgres"),
      import("@autoforge/object-store/minio"),
      import("nats"),
      import("redis"),
    ]);
    const database = createPostgresDatabase({
      connectionString: config.databaseUrl,
      migrationsFolder: config.migrationsFolder,
    });
    try {
      await database.ready;
      const nats = await connect({
        servers: config.natsServers,
        timeout: 5_000,
        reconnect: false,
      });
      const jetStream = await nats.jetstreamManager().catch(async (error: unknown) => {
        await nats.close();
        throw error;
      });
      const redis = createClient({
        url: config.redisUrl,
        socket: {
          connectTimeout: 5_000,
          reconnectStrategy: false,
        },
      });
      redis.on("error", () => {
        // Connection failures are surfaced by connect(), ping(), or readiness checks.
      });
      await redis.connect().catch(async (error: unknown) => {
        await Promise.allSettled([nats.close(), redis.close()]);
        throw error;
      });
      runnerRequestLimiter = new RedisRequestLimiter((script, options) =>
        redis.eval(script, options),
      );
      fullInfrastructure = {
        ready: async () => {
          await Promise.all([jetStream.getAccountInfo(), redis.ping()]);
        },
        close: async () => {
          await Promise.allSettled([nats.drain(), redis.close(), database.close()]);
        },
      };
    } catch (error) {
      await database.close();
      throw new Error("无法初始化 Full 模式基础设施。", { cause: error });
    }
    catalog = new PostgresCaseCatalogRepository(database);
    suites = new PostgresCaseSuiteRepository(database);
    runners = new PostgresRunnerRepository(database);
    objectStore = new MinioObjectStore(config.minio);
  }
  const discovery = new TestNgJarDiscovery({ maxJarBytes: config.maxJarBytes });
  const clock = { now: () => new Date() };
  const ids = { next: () => uuidV7() };
  const importTestNgJar = new ImportTestNgJarService({
    discovery,
    objectStore,
    catalog,
    clock,
    ids,
  });
  const caseSources = new CaseSourceService(catalog, objectStore);
  const caseSuites = new CaseSuiteService(suites, catalog, clock, ids);
  const runnerControl = new RunnerControlService(
    runners,
    {
      issue: () => randomBytes(32).toString("base64url"),
      hash: (value) => createHash("sha256").update(value).digest("hex"),
      verifyBootstrapToken: (value) => secureEqual(value, config.runnerBootstrapToken ?? ""),
    },
    clock,
    ids,
  );

  return {
    config,
    catalog,
    discovery,
    objectStore,
    importTestNgJar,
    caseSources,
    suites,
    caseSuites,
    runners,
    runnerControl,
    runnerRequestLimiter,
    fullInfrastructure,
  };
}

function secureEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

const globalServices = globalThis as typeof globalThis & {
  __autoforgePlatformServices?: Promise<PlatformServices>;
};

export function getPlatformServices(): Promise<PlatformServices> {
  globalServices.__autoforgePlatformServices ??= createPlatformServices();
  return globalServices.__autoforgePlatformServices;
}
