import { z } from "zod";

export const infrastructureDependencySchema = z.enum(["database", "objectStore", "queue", "cache"]);
export type InfrastructureDependency = z.infer<typeof infrastructureDependencySchema>;

export const infrastructureMetricSchema = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  value: z.union([z.number().finite(), z.string().max(500), z.boolean(), z.null()]),
  unit: z.enum(["bytes", "count", "percent", "seconds", "milliseconds", "text"]).default("text"),
  detail: z.string().max(500).optional(),
});
export type InfrastructureMetric = z.infer<typeof infrastructureMetricSchema>;

export const postgresStorageSampleSchema = z
  .object({
    schemaVersion: z.literal(1),
    capacityBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sampledAt: z.string().datetime(),
  })
  .refine((sample) => sample.availableBytes <= sample.capacityBytes);

export const postgresStorageCapacitySchema = z
  .object({
    status: z.enum(["available", "stale", "not_configured", "permission_denied", "unavailable"]),
    detail: z.string().min(1).max(1000),
    sampledAt: z.string().datetime().optional(),
    capacityBytes: z.number().int().positive().optional(),
    availableBytes: z.number().int().nonnegative().optional(),
    usedPercent: z.number().min(0).max(100).optional(),
  })
  .superRefine((value, context) => {
    if (value.status === "available" || value.status === "stale") {
      if (
        value.capacityBytes === undefined ||
        value.availableBytes === undefined ||
        !value.sampledAt
      )
        context.addIssue({ code: "custom", message: "磁盘采样缺少容量或时间。" });
      else if (value.availableBytes > value.capacityBytes)
        context.addIssue({ code: "custom", message: "磁盘可用空间不能大于总容量。" });
    }
  });
export type PostgresStorageCapacity = z.infer<typeof postgresStorageCapacitySchema>;

export const infrastructureUsageSchema = z.object({
  dependency: infrastructureDependencySchema,
  provider: z.string().min(1).max(100),
  sampledAt: z.string().datetime(),
  status: z.enum(["ready", "partial", "unavailable"]),
  metrics: z.array(infrastructureMetricSchema).max(40),
  notes: z.array(z.string().max(1000)).max(20),
  storage: postgresStorageCapacitySchema.optional(),
});
export type InfrastructureUsage = z.infer<typeof infrastructureUsageSchema>;
export type InfrastructureUsageSample = Pick<InfrastructureUsage, "metrics" | "notes"> & {
  storage?: PostgresStorageCapacity;
};
