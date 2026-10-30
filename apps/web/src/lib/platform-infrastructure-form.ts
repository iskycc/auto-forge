import {
  infrastructureConnectionUrl,
  logMaintenanceUsesBusinessDatabase,
  platformInfrastructureCheckSchema,
  type PlatformInfrastructureCheck,
  type PlatformInfrastructureComponent,
  type UpdatePlatformConfigurationInput,
} from "@autoforge/contracts";

export const infrastructureLabels: Record<PlatformInfrastructureComponent, string> = {
  postgres: "PostgreSQL 主库",
  logs: "PostgreSQL 日志库",
  redis: "Redis 缓存",
  nats: "NATS 消息队列",
  minio: "MinIO 对象存储",
};
const fieldLabels: Record<string, string> = {
  host: "IP / 主机名",
  port: "端口",
  username: "用户名",
  password: "密码",
  database: "数据库",
  maintenanceDatabase: "维护数据库",
  databasePrefix: "每日库名前缀",
  accessKey: "Access Key",
  secretKey: "Secret Key",
  bucket: "Bucket",
  token: "Token",
  region: "Region",
};
const text = (form: FormData, name: string) => String(form.get(name) ?? "");

export function infrastructureTargetFromForm(
  form: FormData,
  component: PlatformInfrastructureComponent,
): PlatformInfrastructureCheck {
  const value = (field: string) => text(form, `${component}.${field}`);
  const connection = {
    host: value("host").trim(),
    port: Number(value("port")),
    ...(component === "postgres" || component === "logs"
      ? { username: value("username"), password: value("password"), sslMode: value("sslMode") }
      : {}),
    ...(component === "postgres" ? { database: value("database").trim() } : {}),
    ...(component === "logs"
      ? {
          name: "初始化日志服务器",
          maintenanceDatabase: value("maintenanceDatabase").trim(),
          databasePrefix: value("databasePrefix").trim(),
        }
      : {}),
    ...(component === "redis"
      ? {
          username: value("username"),
          password: value("password"),
          database: Number(value("database")),
          tls: value("tls") === "true",
        }
      : {}),
    ...(component === "nats" ? { token: value("token"), tls: value("tls") === "true" } : {}),
    ...(component === "minio"
      ? {
          accessKey: value("accessKey"),
          secretKey: value("secretKey"),
          bucket: value("bucket").trim(),
          region: value("region").trim(),
          tls: value("tls") === "true",
        }
      : {}),
  };
  const parsed = platformInfrastructureCheckSchema.safeParse({ component, connection });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = String(issue.path.at(-1) ?? "");
    const message =
      issue.code === "too_small"
        ? "不能为空或小于允许的最小值。"
        : issue.code === "too_big"
          ? "超过允许的最大值。"
          : issue.message.startsWith("Invalid")
            ? "请检查填写内容。"
            : issue.message;
    throw new Error(
      `${infrastructureLabels[component]} · ${fieldLabels[field] ?? field}：${message}`,
    );
  }
  return parsed.data;
}

export function fullConfigurationFromSetup(
  form: FormData,
  configured: boolean,
): NonNullable<UpdatePlatformConfigurationInput["full"]> {
  const result: NonNullable<UpdatePlatformConfigurationInput["full"]> = {};
  for (const component of ["postgres", "redis", "nats", "minio", "logs"] as const) {
    if (component === "logs" && text(form, "logs.enabled") !== "true") continue;
    if (configured && component !== "logs" && !text(form, `${component}.host`).trim()) {
      // A completely untouched card preserves existing secrets. Partial credentials must not vanish.
      if (
        ["username", "password", "token", "accessKey", "secretKey"].some((field) =>
          text(form, `${component}.${field}`),
        )
      )
        throw new Error(`${infrastructureLabels[component]}：请填写 IP / 主机名后重新保存。`);
      continue;
    }
    const target = infrastructureTargetFromForm(form, component);
    switch (target.component) {
      case "postgres":
        result.databaseUrl = infrastructureConnectionUrl(target);
        break;
      case "redis":
        result.redisUrl = infrastructureConnectionUrl(target);
        break;
      case "nats":
        result.natsServers = [infrastructureConnectionUrl(target)];
        result.natsToken = target.connection.token || null;
        break;
      case "logs":
        result.logServer = target.connection;
        break;
      case "minio": {
        const { host, port, tls, accessKey, secretKey, bucket, region } = target.connection;
        const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
        result.minioEndpoint = `${tls ? "https" : "http"}://${address}:${port}`;
        result.minioAccessKey = accessKey;
        result.minioSecretKey = secretKey;
        result.minioBucket = bucket;
        result.minioRegion = region;
      }
    }
  }
  if (
    result.databaseUrl &&
    result.logServer &&
    logMaintenanceUsesBusinessDatabase(result.databaseUrl, result.logServer)
  ) {
    throw new Error("日志维护库不能与主平台业务库使用相同地址和库名，请填写独立日志服务的维护库。");
  }
  return result;
}
