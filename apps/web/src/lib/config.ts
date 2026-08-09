import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

const environmentSchema = z
  .object({
    AUTOFORGE_MODE: z.enum(["lite", "full"]).default("lite"),
    AUTOFORGE_DATA_DIR: z.string().min(1).optional(),
    AUTOFORGE_MAX_JAR_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(268_435_456)
      .default(33_554_432),
    AUTOFORGE_RUNNER_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
    AUTOFORGE_RUNNER_CLAIM_RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(120),
    AUTOFORGE_ADMIN_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
    AUTOFORGE_MASTER_KEY: z.string().min(40).max(128).optional(),
    AUTOFORGE_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    AUTOFORGE_TERMINAL_ACCESS_TOKEN: z.string().min(32).optional(),
    AUTOFORGE_SCHEDULER_MAX_CPU_PERCENT: z.coerce.number().min(1).max(100).default(85),
    AUTOFORGE_SCHEDULER_MAX_MEMORY_PERCENT: z.coerce.number().min(1).max(100).default(85),
    AUTOFORGE_SCHEDULER_MAX_LOAD_PER_CPU: z.coerce.number().min(0.1).max(100).default(1),
    AUTOFORGE_SCHEDULER_METRICS_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(15)
      .max(300)
      .default(45),
    AUTOFORGE_DATABASE_URL: z.string().min(1).optional(),
    AUTOFORGE_NATS_SERVERS: z.string().min(1).optional(),
    AUTOFORGE_REDIS_URL: z.url().optional(),
    AUTOFORGE_MINIO_ENDPOINT: z.url().optional(),
    AUTOFORGE_MINIO_ACCESS_KEY: z.string().min(1).optional(),
    AUTOFORGE_MINIO_SECRET_KEY: z.string().min(1).optional(),
    AUTOFORGE_MINIO_BUCKET: z.string().min(3).max(63).optional(),
    AUTOFORGE_MINIO_REGION: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.AUTOFORGE_MODE !== "full") return;
    for (const key of [
      "AUTOFORGE_DATABASE_URL",
      "AUTOFORGE_NATS_SERVERS",
      "AUTOFORGE_REDIS_URL",
      "AUTOFORGE_MINIO_ENDPOINT",
      "AUTOFORGE_MINIO_ACCESS_KEY",
      "AUTOFORGE_MINIO_SECRET_KEY",
      "AUTOFORGE_MINIO_BUCKET",
    ] as const) {
      if (!value[key])
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required in full mode`,
        });
    }
  });

type CommonConfig = {
  workspaceRoot: string;
  maxJarBytes: number;
  runnerBootstrapToken?: string;
  adminBootstrapToken?: string;
  masterKey?: string;
  sessionTtlHours: number;
  terminalAccessToken?: string;
  runnerClaimRateLimitPerMinute: number;
  scheduler: {
    maximumCpuUtilizationPercent: number;
    maximumMemoryUtilizationPercent: number;
    maximumLoadPerCpu: number;
    metricsMaximumAgeSeconds: number;
  };
};

export type AppConfig = CommonConfig &
  (
    | {
        mode: "lite";
        dataDirectory: string;
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
          region?: string;
        };
      }
  );

function findWorkspaceRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("无法定位包含 pnpm-workspace.yaml 的 AutoForge 工作区根目录。");
    }
    current = parent;
  }
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const common = {
    workspaceRoot,
    maxJarBytes: parsed.AUTOFORGE_MAX_JAR_BYTES,
    runnerClaimRateLimitPerMinute: parsed.AUTOFORGE_RUNNER_CLAIM_RATE_LIMIT_PER_MINUTE,
    ...(parsed.AUTOFORGE_RUNNER_BOOTSTRAP_TOKEN
      ? { runnerBootstrapToken: parsed.AUTOFORGE_RUNNER_BOOTSTRAP_TOKEN }
      : {}),
    ...(parsed.AUTOFORGE_ADMIN_BOOTSTRAP_TOKEN
      ? { adminBootstrapToken: parsed.AUTOFORGE_ADMIN_BOOTSTRAP_TOKEN }
      : {}),
    ...(parsed.AUTOFORGE_MASTER_KEY ? { masterKey: parsed.AUTOFORGE_MASTER_KEY } : {}),
    sessionTtlHours: parsed.AUTOFORGE_SESSION_TTL_HOURS,
    ...(parsed.AUTOFORGE_TERMINAL_ACCESS_TOKEN
      ? { terminalAccessToken: parsed.AUTOFORGE_TERMINAL_ACCESS_TOKEN }
      : {}),
    scheduler: {
      maximumCpuUtilizationPercent: parsed.AUTOFORGE_SCHEDULER_MAX_CPU_PERCENT,
      maximumMemoryUtilizationPercent: parsed.AUTOFORGE_SCHEDULER_MAX_MEMORY_PERCENT,
      maximumLoadPerCpu: parsed.AUTOFORGE_SCHEDULER_MAX_LOAD_PER_CPU,
      metricsMaximumAgeSeconds: parsed.AUTOFORGE_SCHEDULER_METRICS_MAX_AGE_SECONDS,
    },
  };
  if (parsed.AUTOFORGE_MODE === "full") {
    const endpoint = new URL(parsed.AUTOFORGE_MINIO_ENDPOINT!);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("AUTOFORGE_MINIO_ENDPOINT 必须使用 HTTP 或 HTTPS。");
    }
    if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
      throw new Error("AUTOFORGE_MINIO_ENDPOINT 只能包含协议、主机和端口。");
    }
    return {
      ...common,
      mode: "full",
      databaseUrl: parsed.AUTOFORGE_DATABASE_URL!,
      natsServers: parseServerList(parsed.AUTOFORGE_NATS_SERVERS!),
      redisUrl: validatedRedisUrl(parsed.AUTOFORGE_REDIS_URL!),
      migrationsFolder: join(workspaceRoot, "packages", "db", "drizzle", "postgresql"),
      minio: {
        endPoint: endpoint.hostname,
        ...(endpoint.port ? { port: Number(endpoint.port) } : {}),
        useSSL: endpoint.protocol === "https:",
        accessKey: parsed.AUTOFORGE_MINIO_ACCESS_KEY!,
        secretKey: parsed.AUTOFORGE_MINIO_SECRET_KEY!,
        bucket: parsed.AUTOFORGE_MINIO_BUCKET!,
        ...(parsed.AUTOFORGE_MINIO_REGION ? { region: parsed.AUTOFORGE_MINIO_REGION } : {}),
      },
    };
  }
  const configuredDataDirectory = parsed.AUTOFORGE_DATA_DIR ?? "./data";
  const dataDirectory = isAbsolute(configuredDataDirectory)
    ? configuredDataDirectory
    : resolve(workspaceRoot, configuredDataDirectory);

  return {
    ...common,
    mode: "lite",
    dataDirectory,
    databasePath: join(dataDirectory, "db", "autoforge.sqlite"),
    migrationsFolder: join(workspaceRoot, "packages", "db", "drizzle", "sqlite"),
  };
}

function parseServerList(value: string): string[] {
  const servers = value
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length === 0) throw new Error("AUTOFORGE_NATS_SERVERS 至少需要一个地址。");
  return servers;
}

function validatedRedisUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("AUTOFORGE_REDIS_URL 必须使用 redis 或 rediss 协议。");
  }
  return url.toString();
}
