import { hostname } from "node:os";

import {
  loadPlatformConfiguration,
  PlatformConfigurationStore,
  type LoadPlatformConfigurationOptions,
} from "@autoforge/platform-config";

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadWorkerConfig(options: LoadPlatformConfigurationOptions = {}) {
  const runtime = loadPlatformConfiguration(options);
  const configuration = runtime.persisted;
  const configurationStore = new PlatformConfigurationStore(runtime.paths.dataDirectory);
  if (configuration.mode !== "full" || !configuration.full) {
    throw new Error("独立 worker 只能在已初始化的 Full 模式配置下启动。");
  }
  const endpoint = new URL(configuration.full.minio.endpoint);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("MinIO 地址必须使用 HTTP 或 HTTPS。");
  }
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("MinIO 地址只能包含协议、主机和端口。");
  }
  return {
    databaseUrl: configuration.full.databaseUrl,
    databasePoolMax: configuration.full.databasePoolMax,
    dataDirectory: runtime.paths.dataDirectory,
    natsServers: [...configuration.full.natsServers],
    workerId: `full-worker-${hostname()}-${process.pid}`,
    concurrency: configuration.worker.concurrency,
    healthPort: configuration.worker.healthPort,
    metricsEnabled: configuration.worker.metricsEnabled,
    shutdownGraceMs: configuration.worker.shutdownGraceMs,
    migrationsFolder: runtime.migrationsFolder,
    minio: {
      endPoint: endpoint.hostname,
      ...(endpoint.port ? { port: Number(endpoint.port) } : {}),
      useSSL: endpoint.protocol === "https:",
      accessKey: configuration.full.minio.accessKey,
      secretKey: configuration.full.minio.secretKey,
      bucket: configuration.full.minio.bucket,
      region: configuration.full.minio.region,
    },
    scheduling: { ...configuration.scheduler },
    maxJarBytes: configuration.limits.maxJarBytes,
    testNgTargetJavaVersion: configuration.limits.testNgTargetJavaVersion,
    caseExecutionTimeoutSeconds: configuration.limits.caseExecutionTimeoutSeconds,
    artifactCollectionEnabled: () => configurationStore.read().limits.artifactCollectionEnabled,
  };
}
