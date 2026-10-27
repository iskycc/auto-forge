import { z } from "zod";

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
