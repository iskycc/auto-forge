import type { UpdatePlatformConfigurationInput } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type { PersistedPlatformConfiguration } from "@autoforge/platform-config";

export function platformConfigurationView(
  configuration: PersistedPlatformConfiguration,
  configurationFile: string,
  restartRequired = false,
  activation: PlatformConfigurationActivation = {
    appliedImmediatelyFields: [],
    restartRequiredFields: [],
  },
) {
  return {
    revision: configuration.revision,
    mode: configuration.mode,
    web: { ...configuration.web },
    limits: { ...configuration.limits },
    scheduler: { ...configuration.scheduler },
    worker: { ...configuration.worker },
    configurationFile,
    fullConfigured: Boolean(configuration.full),
    restartRequired,
    ...activation,
  };
}

export type PlatformConfigurationActivation = {
  appliedImmediatelyFields: string[];
  restartRequiredFields: string[];
};

export function platformConfigurationActivation(
  current: PersistedPlatformConfiguration,
  saved: PersistedPlatformConfiguration,
): PlatformConfigurationActivation {
  const appliedImmediatelyFields = [
    changed(current.web.publicBaseUrl, saved.web.publicBaseUrl) ? "外部访问地址" : undefined,
    changed(current.limits.artifactCollectionEnabled, saved.limits.artifactCollectionEnabled)
      ? "产物收集"
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const restartRequiredFields = [
    changed(current.mode, saved.mode) ? "部署模式" : undefined,
    changed(current.web.hostname, saved.web.hostname) ? "监听地址" : undefined,
    changed(current.web.port, saved.web.port) ? "HTTP 端口" : undefined,
    changed(current.web.publicDashboardRefreshSeconds, saved.web.publicDashboardRefreshSeconds)
      ? "公开大盘刷新间隔"
      : undefined,
    changed(restartOnlyLimits(current), restartOnlyLimits(saved)) ? "容量与会话限制" : undefined,
    changed(current.scheduler, saved.scheduler) ? "调度阈值" : undefined,
    changed(current.worker, saved.worker) ? "后台 worker" : undefined,
    changed(current.full, saved.full) ? "Full 基础设施" : undefined,
  ].filter((value): value is string => Boolean(value));
  return { appliedImmediatelyFields, restartRequiredFields };
}

function restartOnlyLimits(configuration: PersistedPlatformConfiguration) {
  return {
    maxJarBytes: configuration.limits.maxJarBytes,
    testNgTargetJavaVersion: configuration.limits.testNgTargetJavaVersion,
    runnerClaimRateLimitPerMinute: configuration.limits.runnerClaimRateLimitPerMinute,
    sessionTtlHours: configuration.limits.sessionTtlHours,
    authLoginAttemptsPerWindow: configuration.limits.authLoginAttemptsPerWindow,
    caseExecutionTimeoutSeconds: configuration.limits.caseExecutionTimeoutSeconds,
  };
}

function changed(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function mergePlatformConfiguration(
  current: PersistedPlatformConfiguration,
  input: UpdatePlatformConfigurationInput,
): PersistedPlatformConfiguration {
  return {
    ...current,
    mode: input.mode,
    web: { ...input.web },
    limits: { ...input.limits },
    scheduler: { ...input.scheduler },
    worker: { ...input.worker },
    ...(input.mode === "full" || input.full
      ? { full: mergedFullConfiguration(current.full, input.full) }
      : {}),
  };
}

function mergedFullConfiguration(
  current: PersistedPlatformConfiguration["full"],
  input: UpdatePlatformConfigurationInput["full"],
): NonNullable<PersistedPlatformConfiguration["full"]> {
  const databaseUrl = input?.databaseUrl ?? current?.databaseUrl;
  const natsServers = input?.natsServers ?? current?.natsServers;
  const redisUrl = input?.redisUrl ?? current?.redisUrl;
  const endpoint = input?.minioEndpoint ?? current?.minio.endpoint;
  const accessKey = input?.minioAccessKey ?? current?.minio.accessKey;
  const secretKey = input?.minioSecretKey ?? current?.minio.secretKey;
  const bucket = input?.minioBucket ?? current?.minio.bucket;
  const region = input?.minioRegion ?? current?.minio.region;
  const databasePoolMax = input?.databasePoolMax ?? current?.databasePoolMax ?? 10;
  if (
    !databaseUrl ||
    !natsServers ||
    !redisUrl ||
    !endpoint ||
    !accessKey ||
    !secretKey ||
    !bucket ||
    !region
  ) {
    throw new DomainError(
      "FULL_CONFIGURATION_INCOMPLETE",
      "首次启用 Full 模式时必须填写 PostgreSQL、NATS、Redis 和 MinIO 的完整配置。",
    );
  }
  validatedProtocol(databaseUrl, ["postgres:", "postgresql:"], "PostgreSQL");
  for (const server of natsServers) validatedProtocol(server, ["nats:", "tls:"], "NATS");
  validatedProtocol(redisUrl, ["redis:", "rediss:"], "Redis");
  validatedProtocol(endpoint, ["http:", "https:"], "MinIO");
  return {
    databaseUrl,
    databasePoolMax,
    natsServers: [...natsServers],
    redisUrl,
    minio: { endpoint, accessKey, secretKey, bucket, region },
  };
}

function validatedProtocol(value: string, protocols: readonly string[], label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new DomainError("PLATFORM_CONFIGURATION_INVALID", `${label} 地址无效。`, {
      cause: error,
    });
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new DomainError("PLATFORM_CONFIGURATION_INVALID", `${label} 地址协议不受支持。`);
  }
}
