import { z } from "zod";

const common = {
  dataDirectory: z.string().min(1),
  migrationsFolder: z.string().min(1),
  masterKey: z.string().min(1),
  prioritySignal: z.instanceof(SharedArrayBuffer),
};
export const aiThreadConfigurationSchema = z.discriminatedUnion("mode", [
  z.object({ ...common, mode: z.literal("lite"), databasePath: z.string().min(1) }),
  z.object({
    ...common,
    mode: z.literal("full"),
    databaseUrl: z.string().min(1),
    redisUrl: z.string().min(1),
    minio: z.object({
      endPoint: z.string(),
      port: z.number().optional(),
      useSSL: z.boolean(),
      accessKey: z.string(),
      secretKey: z.string(),
      bucket: z.string(),
      region: z.string(),
    }),
  }),
]);
type WithoutPriority<T> = T extends unknown ? Omit<T, "prioritySignal"> : never;
export type AiThreadConfiguration = WithoutPriority<z.infer<typeof aiThreadConfigurationSchema>>;
