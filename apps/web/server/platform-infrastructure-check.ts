import {
  infrastructureConnectionUrl,
  type PlatformInfrastructureCheck,
  type PlatformInfrastructureCheckResult,
} from "@autoforge/contracts/platform-infrastructure";

/** Drivers are loaded only for an explicit, bootstrap-authorized check, including in Lite. */
export async function checkPlatformInfrastructure(
  target: PlatformInfrastructureCheck,
): Promise<PlatformInfrastructureCheckResult> {
  const started = Date.now();
  try {
    await probe(target);
    return {
      ok: true,
      message: successMessages[target.component],
      durationMs: Date.now() - started,
    };
  } catch (cause) {
    return {
      ok: false,
      message: connectionFailureMessage(cause),
      durationMs: Date.now() - started,
    };
  }
}

const successMessages = {
  postgres: "连接成功，主库具备连接、public Schema 使用和建表权限。",
  logs: "连接成功，日志账号具备按日自动建库权限，维护库与平台业务库分离。",
  redis: "连接成功，认证和 PING 检查通过。",
  nats: "连接成功，JetStream 已启用且可访问。",
  minio: "连接成功，Bucket 及临时对象写入、读取和删除检查通过。",
} as const;

async function probe(target: PlatformInfrastructureCheck): Promise<void> {
  switch (target.component) {
    case "postgres":
    case "logs":
      return checkPostgres(target);
    case "redis":
      return checkRedis(target);
    case "nats":
      return checkNats(target);
    case "minio": {
      const { checkMinioConnection } =
        await import("@autoforge/object-store/minio-connection-check");
      return checkMinioConnection(target.connection);
    }
  }
}

async function checkPostgres(
  target: Extract<PlatformInfrastructureCheck, { component: "postgres" | "logs" }>,
): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: infrastructureConnectionUrl(target),
    max: 1,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
    statement_timeout: 3000,
  });
  // pg can emit errors after a connection drops; the awaited query still reports the failure.
  pool.on("error", () => {
    // Query failures are returned below; raw driver events can contain credentials.
  });
  try {
    if (target.component === "postgres") {
      const result = await pool.query<{ allowed: boolean }>(
        "SELECT has_database_privilege(current_database(),'CONNECT') AND has_schema_privilege('public','USAGE') AND has_schema_privilege('public','CREATE') AS allowed",
      );
      if (!result.rows[0]?.allowed)
        throw Object.assign(new Error("Database permissions missing"), {
          code: "MAIN_PERMISSIONS",
        });
    } else {
      const result = await pool.query<{ allowed: boolean; business: string | null }>(
        "SELECT (rolsuper OR rolcreatedb) AS allowed, to_regclass('public.run_batches')::text AS business FROM pg_roles WHERE rolname=current_user",
      );
      if (result.rows[0]?.business)
        throw Object.assign(new Error("Business database selected"), {
          code: "LOG_BUSINESS_DATABASE",
        });
      if (!result.rows[0]?.allowed)
        throw Object.assign(new Error("CREATEDB required"), { code: "LOG_CREATEDB" });
    }
  } finally {
    await pool.end();
  }
}

async function checkRedis(
  target: Extract<PlatformInfrastructureCheck, { component: "redis" }>,
): Promise<void> {
  const { createClient } = await import("redis");
  const client = createClient({
    url: infrastructureConnectionUrl(target),
    socket: { connectTimeout: 3000, socketTimeout: 3000, reconnectStrategy: false },
    commandsQueueMaxLength: 8,
  });
  client.on("error", () => {
    // connect()/ping() report the failure; avoid logging secret-bearing driver text.
  });
  try {
    await client.connect();
    await client.withCommandOptions({ timeout: 3000 }).ping();
  } finally {
    if (client.isOpen) client.destroy();
  }
}

async function checkNats(
  target: Extract<PlatformInfrastructureCheck, { component: "nats" }>,
): Promise<void> {
  const { connect } = await import("nats");
  const connection = await connect({
    servers: [infrastructureConnectionUrl(target)],
    ...(target.connection.token ? { token: target.connection.token } : {}),
    timeout: 3000,
    reconnect: false,
  });
  try {
    const manager = await connection.jetstreamManager({ timeout: 3000 });
    await manager.getAccountInfo();
  } finally {
    await connection.close();
  }
}

export function connectionFailureMessage(cause: unknown): string {
  if (cause instanceof Error && /^(WRONGPASS|NOAUTH)\b/.test(cause.message))
    return "Redis 认证失败，请检查用户名、密码和账号状态。";
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  const messages: Record<string, string> = {
    "28P01": "数据库用户名或密码错误。",
    "28000": "数据库拒绝认证，请检查账号和访问策略。",
    "3D000": "数据库不存在，请先创建填写的数据库。",
    "42501": "数据库权限不足，请检查账号授权。",
    MAIN_PERMISSIONS: "主库账号需要 CONNECT 以及 public Schema 的 USAGE、CREATE 权限。",
    LOG_CREATEDB: "日志库账号需要 CREATEDB 或超级用户权限，以自动创建每日数据库。",
    LOG_BUSINESS_DATABASE: "日志维护库不能填写平台业务库，请使用独立日志服务的 postgres 数据库。",
    ECONNREFUSED: "连接被拒绝，请检查 IP、端口和服务是否启动。",
    ENOTFOUND: "无法解析主机名，请检查 IP 或 DNS 配置。",
    EAI_AGAIN: "主机名解析暂时失败，请检查 DNS。",
    ETIMEDOUT: "连接超时，请检查防火墙、路由及目标服务。",
    TIMEOUT: "连接或能力检查超时，请检查网络及目标服务。",
    AUTHORIZATION_VIOLATION: "NATS 认证失败，请检查 Token 和账号权限。",
    "503": "NATS JetStream 不可用，请确认已启用 JetStream 并授权访问。",
    NoSuchBucket: "MinIO Bucket 不存在，请先创建填写的 Bucket。",
    CHECK_OBJECT_CLEANUP_FAILED: "MinIO 临时测试对象清理失败，请检查对象删除权限及网络连接。",
    AccessDenied: "MinIO 权限不足，需要 Bucket 访问及对象写入、读取、删除权限。",
    InvalidAccessKeyId: "MinIO Access Key 无效。",
    SignatureDoesNotMatch: "MinIO Secret Key 或签名配置错误。",
    CERT_HAS_EXPIRED: "TLS 证书已过期。",
    DEPTH_ZERO_SELF_SIGNED_CERT: "TLS 证书不受信任，请配置受信任的证书。",
  };
  // Never return driver text: it may contain a password, token or connection URL.
  return messages[code] ?? "连接或能力检查失败，请检查地址、端口、认证、TLS 和服务权限。";
}
