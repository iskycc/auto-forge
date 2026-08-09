import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  CaseSourceService,
  CaseSuiteService,
  ExecutionControlService,
  ImportTestNgJarService,
  IdentityAccessService,
  RunBatchSchedulingService,
  RunnerControlService,
  type CaseCatalogRepository,
  type CaseSuiteRepository,
  type JarObjectStorePort,
  type IdentityAccessRepository,
  type ExecutionControlRepository,
  type RunBatchRepository,
  type RunnerRepository,
} from "@autoforge/application";
import {
  createSqliteDatabase,
  SqliteCaseCatalogRepository,
  SqliteCaseSuiteRepository,
  SqliteExecutionControlRepository,
  SqliteIdentityAccessRepository,
  SqliteRunBatchRepository,
  SqliteRunnerRepository,
} from "@autoforge/db/sqlite";
import { LocalObjectStore } from "@autoforge/object-store/local";
import { TestNgJarDiscovery } from "@autoforge/testng-discovery";
import { RunnerProtocolController } from "@autoforge/runner-sdk";

import { loadAppConfig } from "./config";
import { LdapDirectory } from "./ldap-directory";
import { ScryptPasswordHasher } from "./password-hasher";
import { MemoryRequestLimiter, RedisRequestLimiter, type RequestLimiter } from "./request-limiter";
import { uuidV7 } from "./uuid-v7";
import { AesGcmSecretCipher } from "./secret-cipher";

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
  let identities: IdentityAccessRepository;
  let executions: ExecutionControlRepository;
  let batches: RunBatchRepository;
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
    identities = new SqliteIdentityAccessRepository(database);
    executions = new SqliteExecutionControlRepository(database);
    batches = new SqliteRunBatchRepository(database);
    objectStore = new LocalObjectStore(config.dataDirectory);
  } else {
    const [
      {
        createPostgresDatabase,
        PostgresCaseCatalogRepository,
        PostgresCaseSuiteRepository,
        PostgresIdentityAccessRepository,
        PostgresExecutionControlRepository,
        PostgresRunBatchRepository,
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
    identities = new PostgresIdentityAccessRepository(database);
    executions = new PostgresExecutionControlRepository(database);
    batches = new PostgresRunBatchRepository(database);
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
  const runnerCredentials = {
    issue: () => randomBytes(32).toString("base64url"),
    hash: (value: string) => createHash("sha256").update(value).digest("hex"),
    verifyBootstrapToken: (value: string) => secureEqual(value, config.runnerBootstrapToken ?? ""),
  };
  const runnerControl = new RunnerControlService(runners, runnerCredentials, clock, ids);
  const runBatches = new RunBatchSchedulingService(
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
  );
  const secretCipher = new AesGcmSecretCipher(config.masterKey);
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
  );
  await identityAccess.initialize();
  const executionControl = new ExecutionControlService(
    executions,
    runners,
    runnerCredentials,
    secretCipher,
    clock,
    ids,
  );
  const runnerProtocol = new RunnerProtocolController(executionControl);

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
    identities,
    executions,
    identityAccess,
    runnerControl,
    executionControl,
    runnerProtocol,
    runBatches,
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
