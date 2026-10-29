import { z } from "zod";

export const registerDailyLogServerSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    host: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^\s/@?#]+$/, "请输入主机名或 IP，不包含协议或路径。"),
    port: z.number().int().min(1).max(65535).default(5432),
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(4096),
    maintenanceDatabase: z.string().trim().min(1).max(63).default("postgres"),
    databasePrefix: z
      .string()
      .trim()
      .regex(
        /^[a-z][a-z0-9_]{0,31}$/,
        "库名前缀须以小写字母开头，最多 32 个小写字母、数字或下划线。",
      )
      .default("autoforge_logs"),
    sslMode: z.enum(["disable", "require", "verify-full"]).default("disable"),
  })
  .strict();
export type RegisterDailyLogServerInput = z.infer<typeof registerDailyLogServerSchema>;

export const registerLogDatabaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  databaseUrl: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => {
      try {
        const url = new URL(value);
        return ["postgres:", "postgresql:"].includes(url.protocol) && url.pathname.length > 1;
      } catch {
        return false;
      }
    }, "请输入包含数据库名的 PostgreSQL 连接地址。"),
});

export const logDatabaseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  address: z.string(),
  active: z.boolean(),
  batchCount: z.number().int().nonnegative(),
  storedBytes: z.number().nonnegative(),
  createdAt: z.string(),
  storageMode: z.enum(["legacy", "daily", "day"]).optional(),
  server: registerDailyLogServerSchema.omit({ name: true, password: true }).optional(),
});
export type LogDatabase = z.infer<typeof logDatabaseSchema>;
export type RegisterLogDatabaseInput = z.infer<typeof registerLogDatabaseSchema>;

export const selectLogDatabaseSchema = z.object({
  databaseId: z.string().uuid().nullable(),
  revision: z.number().int().positive(),
});
export type LogDatabasePage = {
  items: LogDatabase[];
  nextCursor?: string;
  activeDatabaseId: string | null;
  revision: number;
};
