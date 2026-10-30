import { z } from "zod";
import { registerDailyLogServerSchema, type RegisterDailyLogServerInput } from "./log-databases.ts";

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((host) => {
    if (/[\s/@?#\\]/.test(host)) return false;
    try {
      const parsed = new URL(
        `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}`,
      );
      return parsed.port === "" && parsed.pathname === "/" && parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }, "请输入 IP 或主机名，不包含协议、端口或路径。");
const portSchema = z.number().int().min(1).max(65535);
const credentials = { username: z.string().min(1).max(128), password: z.string().min(1).max(4096) };
export const setupPostgresConnectionSchema = z.object({
  host: hostSchema,
  port: portSchema.default(5432),
  ...credentials,
  database: z.string().trim().min(1).max(63),
  sslMode: z.enum(["disable", "require", "verify-full"]).default("disable"),
});
export const setupRedisConnectionSchema = z.object({
  host: hostSchema,
  port: portSchema.default(6379),
  username: z.string().max(128).default(""),
  password: z.string().max(4096).default(""),
  database: z.number().int().min(0).max(15).default(0),
  tls: z.boolean().default(false),
});
export const setupNatsConnectionSchema = z.object({
  host: hostSchema,
  port: portSchema.default(4222),
  tls: z.boolean().default(false),
  token: z
    .string()
    .max(4096)
    .default("")
    .refine((value) => value === "" || value.length >= 16, "认证 Token 至少需要 16 位。"),
});
export const setupMinioConnectionSchema = z.object({
  host: hostSchema,
  port: portSchema.default(9000),
  tls: z.boolean().default(false),
  accessKey: z.string().min(1).max(1024),
  secretKey: z.string().min(1).max(4096),
  bucket: z
    .string()
    .trim()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/, "Bucket 仅支持小写字母、数字、点和连字符。"),
  region: z.string().trim().min(1).max(128).default("us-east-1"),
});
export const platformInfrastructureCheckSchema = z.discriminatedUnion("component", [
  z.object({ component: z.literal("postgres"), connection: setupPostgresConnectionSchema }),
  z.object({
    component: z.literal("logs"),
    connection: registerDailyLogServerSchema.extend({ host: hostSchema }),
  }),
  z.object({ component: z.literal("redis"), connection: setupRedisConnectionSchema }),
  z.object({ component: z.literal("nats"), connection: setupNatsConnectionSchema }),
  z.object({ component: z.literal("minio"), connection: setupMinioConnectionSchema }),
]);
export type PlatformInfrastructureCheck = z.infer<typeof platformInfrastructureCheckSchema>;
export type PlatformInfrastructureComponent = PlatformInfrastructureCheck["component"];
export const platformInfrastructureCheckResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(500),
  durationMs: z.number().int().nonnegative(),
});
export type PlatformInfrastructureCheckResult = z.infer<
  typeof platformInfrastructureCheckResultSchema
>;

export function logMaintenanceUsesBusinessDatabase(
  databaseUrl: string,
  server: RegisterDailyLogServerInput,
): boolean {
  const business = new URL(databaseUrl);
  const maintenance = new URL(
    infrastructureConnectionUrl({ component: "logs", connection: server }),
  );
  return (
    business.hostname.toLowerCase() === maintenance.hostname.toLowerCase() &&
    (business.port || "5432") === (maintenance.port || "5432") &&
    decodeURIComponent(business.pathname) === decodeURIComponent(maintenance.pathname)
  );
}
export const checkBootstrapInfrastructureInputSchema = z.object({
  bootstrapToken: z.string().min(32).max(1024),
  target: platformInfrastructureCheckSchema,
});

/** URL encoding belongs to the boundary: passwords and IPv6 must survive unchanged. */
export function infrastructureConnectionUrl(
  input: Exclude<PlatformInfrastructureCheck, { component: "minio" }>,
): string {
  const connection = input.connection;
  const host =
    connection.host.includes(":") && !connection.host.startsWith("[")
      ? `[${connection.host}]`
      : connection.host;
  const protocol =
    input.component === "redis"
      ? input.connection.tls
        ? "rediss"
        : "redis"
      : input.component === "nats"
        ? input.connection.tls
          ? "tls"
          : "nats"
        : "postgresql";
  const url = new URL(`${protocol}://${host}:${connection.port}`);
  if (input.component === "postgres" || input.component === "logs") {
    url.username = encodeURIComponent(input.connection.username);
    url.password = encodeURIComponent(input.connection.password);
    url.pathname = `/${encodeURIComponent(input.component === "logs" ? input.connection.maintenanceDatabase : input.connection.database)}`;
    url.searchParams.set("sslmode", input.connection.sslMode);
    if (input.connection.sslMode === "require") url.searchParams.set("uselibpqcompat", "true");
  } else if (input.component === "redis") {
    url.username = encodeURIComponent(input.connection.username);
    url.password = encodeURIComponent(input.connection.password);
    url.pathname = `/${input.connection.database}`;
  }
  return url.toString();
}
