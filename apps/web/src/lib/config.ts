import { resolve } from "node:path";

import {
  PlatformConfigurationStore,
  loadPlatformConfiguration,
  type LoadPlatformConfigurationOptions,
} from "@autoforge/platform-config";

type CommonConfig = {
  workspaceRoot: string;
  dataDirectory: string;
  configurationFile: string;
  configurationRevision: number;
  maxJarBytes: number;
  testNgTargetJavaVersion: number;
  runnerBootstrapToken: string;
  adminBootstrapToken: string;
  masterKey: string;
  sessionTtlHours: number;
  terminalAccessToken: string;
  runnerClaimRateLimitPerMinute: number;
  authLoginAttemptsPerWindow: number;
  publicDashboardRefreshSeconds: number;
  metricsEnabled: boolean;
  web: {
    hostname: string;
    port: number;
    publicBaseUrl?: string;
  };
  scheduler: {
    maximumCpuUtilizationPercent: number;
    maximumMemoryUtilizationPercent: number;
    maximumLoadPerCpu: number;
    metricsMaximumAgeSeconds: number;
    projectMaximumConcurrency: number;
    priorityAgingIntervalMinutes: number;
  };
};

export type AppConfig = CommonConfig &
  (
    | {
        mode: "lite";
        databasePath: string;
        migrationsFolder: string;
      }
    | {
        mode: "full";
        databaseUrl: string;
        natsServers: string[];
        redisUrl: string;
        migrationsFolder: string;
        minio: {
          endPoint: string;
          port?: number;
          useSSL: boolean;
          accessKey: string;
          secretKey: string;
          bucket: string;
          region: string;
        };
      }
  );

export function loadAppConfig(options: LoadPlatformConfigurationOptions = {}): AppConfig {
  const runtime = loadPlatformConfiguration(options);
  const { persisted } = runtime;
  const common: CommonConfig = {
    workspaceRoot: runtime.workspaceRoot,
    dataDirectory: runtime.paths.dataDirectory,
    configurationFile: runtime.paths.configurationFile,
    configurationRevision: persisted.revision,
    maxJarBytes: persisted.limits.maxJarBytes,
    testNgTargetJavaVersion: persisted.limits.testNgTargetJavaVersion,
    runnerClaimRateLimitPerMinute: persisted.limits.runnerClaimRateLimitPerMinute,
    runnerBootstrapToken: persisted.secrets.runnerBootstrapToken,
    adminBootstrapToken: persisted.secrets.adminBootstrapToken,
    masterKey: persisted.secrets.masterKey,
    sessionTtlHours: persisted.limits.sessionTtlHours,
    authLoginAttemptsPerWindow: persisted.limits.authLoginAttemptsPerWindow,
    terminalAccessToken: persisted.secrets.terminalAccessToken,
    publicDashboardRefreshSeconds: persisted.web.publicDashboardRefreshSeconds,
    metricsEnabled: persisted.worker.metricsEnabled,
    web: {
      hostname: persisted.web.hostname,
      port: persisted.web.port,
      ...(persisted.web.publicBaseUrl ? { publicBaseUrl: persisted.web.publicBaseUrl } : {}),
    },
    scheduler: { ...persisted.scheduler },
  };
  if (persisted.mode === "lite") {
    if (!runtime.databasePath) throw new Error("Lite 模式缺少 SQLite 数据库路径。");
    return {
      ...common,
      mode: "lite",
      databasePath: runtime.databasePath,
      migrationsFolder: runtime.migrationsFolder,
    };
  }
  if (!persisted.full) throw new Error("Full 模式缺少基础设施配置。");
  const endpoint = validatedHttpEndpoint(persisted.full.minio.endpoint);
  return {
    ...common,
    mode: "full",
    databaseUrl: persisted.full.databaseUrl,
    natsServers: [...persisted.full.natsServers],
    redisUrl: validatedRedisUrl(persisted.full.redisUrl),
    migrationsFolder: runtime.migrationsFolder,
    minio: {
      endPoint: endpoint.hostname,
      ...(endpoint.port ? { port: Number(endpoint.port) } : {}),
      useSSL: endpoint.protocol === "https:",
      accessKey: persisted.full.minio.accessKey,
      secretKey: persisted.full.minio.secretKey,
      bucket: persisted.full.minio.bucket,
      region: persisted.full.minio.region,
    },
  };
}

export function appConfigurationStore(config: Pick<AppConfig, "dataDirectory">) {
  return new PlatformConfigurationStore(resolve(config.dataDirectory));
}

function validatedHttpEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("MinIO 地址必须使用 HTTP 或 HTTPS。");
  }
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("MinIO 地址只能包含协议、主机和端口。");
  }
  return endpoint;
}

function validatedRedisUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("Redis 地址必须使用 redis 或 rediss 协议。");
  }
  return url.toString();
}
