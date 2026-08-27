import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

export const PLATFORM_CONFIGURATION_SCHEMA_VERSION = 1 as const;
export const PLATFORM_CONFIGURATION_FILE = "platform.json";
export const INITIAL_ADMIN_TOKEN_FILE = "initial-admin-token";
export const MINIMUM_JAR_UPLOAD_BYTES = 1_048_576;
export const MAXIMUM_JAR_UPLOAD_BYTES = 268_435_456;
export const DEFAULT_PLATFORM_TIME_ZONE = "Asia/Shanghai";

function isSupportedTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

const platformTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(isSupportedTimeZone, "请输入有效的 IANA 时区，例如 Asia/Shanghai。");

const schedulerSchema = z.object({
  maximumCpuUtilizationPercent: z.number().min(1).max(100),
  maximumMemoryUtilizationPercent: z.number().min(1).max(100),
  maximumLoadPerCpu: z.number().min(0.1).max(100),
  metricsMaximumAgeSeconds: z.number().int().min(15).max(300),
  projectMaximumConcurrency: z.number().int().min(1).max(10_000).default(128),
  priorityAgingIntervalMinutes: z.number().int().min(1).max(1_440).default(5),
});

const fullInfrastructureSchema = z.object({
  databaseUrl: z.string().min(1).max(4_096),
  // PostgreSQL 连接池上限；旧配置文件缺失时沿用历史硬编码的 10。
  databasePoolMax: z.number().int().min(1).max(100).default(10),
  natsServers: z.array(z.string().min(1).max(1_024)).min(1).max(8),
  redisUrl: z.url().max(2_048),
  minio: z.object({
    endpoint: z.url().max(2_048),
    accessKey: z.string().min(1).max(1_024),
    secretKey: z.string().min(1).max(4_096),
    bucket: z.string().min(3).max(63),
    region: z.string().min(1).max(128),
  }),
});

export const persistedPlatformConfigurationSchema = z
  .object({
    schemaVersion: z.literal(PLATFORM_CONFIGURATION_SCHEMA_VERSION),
    revision: z.number().int().positive(),
    mode: z.enum(["lite", "full"]),
    web: z.object({
      hostname: z.string().min(1).max(255),
      port: z.number().int().min(1).max(65_535),
      // 旧版本没有时区字段；升级读取时统一回落到东八区，不依赖宿主机时区。
      timeZone: platformTimeZoneSchema.default(DEFAULT_PLATFORM_TIME_ZONE),
      publicBaseUrl: z
        .url()
        .max(2_048)
        .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
          message: "执行机可访问地址必须使用 HTTP 或 HTTPS。",
        })
        .optional(),
      publicDashboardRefreshSeconds: z.number().int().min(5).max(300),
    }),
    limits: z.object({
      maxJarBytes: z.number().int().min(MINIMUM_JAR_UPLOAD_BYTES).max(MAXIMUM_JAR_UPLOAD_BYTES),
      testNgTargetJavaVersion: z.number().int().min(8).max(100),
      runnerClaimRateLimitPerMinute: z.number().int().min(1).max(10_000),
      sessionTtlHours: z.number().int().min(1).max(168),
      // 兼容旧配置文件：缺失时回落到与历史硬编码一致的 10 次/15 分钟。
      authLoginAttemptsPerWindow: z.number().int().min(1).max(100_000).default(10),
      // 用例执行超时（秒），由 adapter 自身看门狗管理；旧配置文件缺失时默认 600 秒。
      caseExecutionTimeoutSeconds: z.number().int().min(1).max(86_400).default(600),
      // 产物收集全局开关；关闭后执行规格不下发产物规则，Agent 不扫描不上传产物。
      artifactCollectionEnabled: z.boolean().default(true),
    }),
    scheduler: schedulerSchema,
    worker: z.object({
      concurrency: z.number().int().min(1).max(256),
      healthPort: z.number().int().min(1).max(65_535),
      metricsEnabled: z.boolean(),
      shutdownGraceMs: z.number().int().min(1_000).max(300_000),
    }),
    secrets: z.object({
      runnerBootstrapToken: z.string().min(32).max(1_024),
      adminBootstrapToken: z.string().min(32).max(1_024),
      terminalAccessToken: z.string().min(32).max(1_024),
      masterKey: z.string().min(40).max(128),
    }),
    full: fullInfrastructureSchema.optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((configuration, context) => {
    if (configuration.mode === "full" && !configuration.full) {
      context.addIssue({
        code: "custom",
        path: ["full"],
        message: "Full 模式需要完整基础设施配置。",
      });
    }
  });

export type PersistedPlatformConfiguration = z.infer<typeof persistedPlatformConfigurationSchema>;

export type PlatformConfigurationPaths = {
  dataDirectory: string;
  configurationDirectory: string;
  configurationFile: string;
  initialAdminTokenFile: string;
};

export type LoadPlatformConfigurationOptions = {
  dataDirectory?: string;
  workspaceRoot?: string;
  now?: Date;
};

export type RuntimePlatformConfiguration = {
  persisted: PersistedPlatformConfiguration;
  paths: PlatformConfigurationPaths;
  workspaceRoot: string;
  databasePath?: string;
  migrationsFolder: string;
};

export class PlatformConfigurationConflictError extends Error {
  constructor() {
    super("平台配置已被其他管理员修改，请刷新后重试。");
    this.name = "PlatformConfigurationConflictError";
  }
}

export function isPlatformConfigurationConflictError(
  error: unknown,
): error is PlatformConfigurationConflictError {
  return error instanceof Error && error.name === "PlatformConfigurationConflictError";
}

export class PlatformConfigurationStore {
  readonly paths: PlatformConfigurationPaths;

  constructor(dataDirectory: string) {
    const normalizedDataDirectory = resolve(dataDirectory);
    const configurationDirectory = join(normalizedDataDirectory, "config");
    this.paths = {
      dataDirectory: normalizedDataDirectory,
      configurationDirectory,
      configurationFile: join(configurationDirectory, PLATFORM_CONFIGURATION_FILE),
      initialAdminTokenFile: join(configurationDirectory, INITIAL_ADMIN_TOKEN_FILE),
    };
  }

  initialize(now = new Date()): PersistedPlatformConfiguration {
    mkdirSync(this.paths.configurationDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.paths.configurationDirectory, 0o700);
    if (!existsSync(this.paths.configurationFile)) {
      let initial = defaultConfiguration(now);
      try {
        writeExclusiveSecret(this.paths.initialAdminTokenFile, initial.secrets.adminBootstrapToken);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        initial = defaultConfiguration(
          now,
          readFileSync(this.paths.initialAdminTokenFile, "utf8").trim(),
        );
      }
      try {
        writeExclusiveJson(this.paths.configurationFile, initial);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    }
    return this.read();
  }

  read(): PersistedPlatformConfiguration {
    assertPrivateFile(this.paths.configurationFile);
    const parsedJson: unknown = JSON.parse(readFileSync(this.paths.configurationFile, "utf8"));
    return persistedPlatformConfigurationSchema.parse(parsedJson);
  }

  replace(
    next: PersistedPlatformConfiguration,
    expectedRevision: number,
    now = new Date(),
  ): PersistedPlatformConfiguration {
    const current = this.read();
    if (current.revision !== expectedRevision) {
      throw new PlatformConfigurationConflictError();
    }
    const validated = persistedPlatformConfigurationSchema.parse({
      ...next,
      schemaVersion: PLATFORM_CONFIGURATION_SCHEMA_VERSION,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: now.toISOString(),
    });
    writeAtomicJson(this.paths.configurationFile, validated);
    return validated;
  }

  consumeInitialAdminTokenFile(): void {
    if (!existsSync(this.paths.initialAdminTokenFile)) return;
    unlinkSync(this.paths.initialAdminTokenFile);
  }
}

export function resolvePlatformDataDirectory(
  argumentsList: readonly string[] = process.argv.slice(2),
  currentDirectory = process.cwd(),
): string {
  const argument = readDataDirectoryArgument(argumentsList);
  if (argument)
    return isAbsolute(argument)
      ? resolve(/* turbopackIgnore: true */ argument)
      : resolve(/* turbopackIgnore: true */ currentDirectory, argument);
  const systemDirectory = "/var/lib/autoforge";
  if (existsSync(systemDirectory)) return systemDirectory;
  return resolve(currentDirectory, "data");
}

export function loadPlatformConfiguration(
  options: LoadPlatformConfigurationOptions = {},
): RuntimePlatformConfiguration {
  const dataDirectory = options.dataDirectory ?? resolvePlatformDataDirectory();
  const workspaceRoot = options.workspaceRoot ?? findWorkspaceRoot(process.cwd());
  const store = new PlatformConfigurationStore(dataDirectory);
  const persisted = store.initialize(options.now);
  const migrationsFolder = join(
    workspaceRoot,
    "packages",
    "db",
    "drizzle",
    persisted.mode === "lite" ? "sqlite" : "postgresql",
  );
  return {
    persisted,
    paths: store.paths,
    workspaceRoot,
    ...(persisted.mode === "lite"
      ? { databasePath: join(store.paths.dataDirectory, "db", "autoforge.sqlite") }
      : {}),
    migrationsFolder,
  };
}

function defaultConfiguration(
  now: Date,
  adminBootstrapToken = randomSecret(),
): PersistedPlatformConfiguration {
  const timestamp = now.toISOString();
  return {
    schemaVersion: PLATFORM_CONFIGURATION_SCHEMA_VERSION,
    revision: 1,
    mode: "lite",
    web: {
      hostname: "0.0.0.0",
      port: 3000,
      timeZone: DEFAULT_PLATFORM_TIME_ZONE,
      publicDashboardRefreshSeconds: 15,
    },
    limits: {
      maxJarBytes: MAXIMUM_JAR_UPLOAD_BYTES,
      testNgTargetJavaVersion: 21,
      runnerClaimRateLimitPerMinute: 120,
      sessionTtlHours: 12,
      authLoginAttemptsPerWindow: 10,
      caseExecutionTimeoutSeconds: 600,
      artifactCollectionEnabled: true,
    },
    scheduler: {
      maximumCpuUtilizationPercent: 85,
      maximumMemoryUtilizationPercent: 85,
      maximumLoadPerCpu: 1,
      metricsMaximumAgeSeconds: 45,
      projectMaximumConcurrency: 128,
      priorityAgingIntervalMinutes: 5,
    },
    worker: {
      concurrency: 16,
      healthPort: 3001,
      metricsEnabled: false,
      shutdownGraceMs: 30_000,
    },
    secrets: {
      runnerBootstrapToken: randomSecret(),
      adminBootstrapToken,
      terminalAccessToken: randomSecret(),
      masterKey: randomBytes(32).toString("base64"),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function readDataDirectoryArgument(argumentsList: readonly string[]): string | undefined {
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument?.startsWith("--data-dir=")) {
      const value = argument.slice("--data-dir=".length).trim();
      if (!value) throw new Error("--data-dir 不能为空。");
      return value;
    }
    if (argument === "--data-dir") {
      const value = argumentsList[index + 1]?.trim();
      if (!value) throw new Error("--data-dir 需要目录参数。");
      return value;
    }
  }
  return undefined;
}

function findWorkspaceRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      // Standalone images preserve this layout even though they do not ship the workspace manifest.
      return resolve(startDirectory);
    }
    current = parent;
  }
}

function writeExclusiveJson(path: string, value: unknown): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusiveSecret(path: string, value: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${value}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomicJson(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function assertPrivateFile(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`平台配置文件权限过宽：${path} 必须仅允许当前用户读写。`);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
