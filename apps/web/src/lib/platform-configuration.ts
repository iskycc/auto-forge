import type { UpdatePlatformConfigurationInput } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type { PersistedPlatformConfiguration } from "@autoforge/platform-config";

export function platformConfigurationView(
  configuration: PersistedPlatformConfiguration,
  configurationFile: string,
  restartRequired = false,
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
  };
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
