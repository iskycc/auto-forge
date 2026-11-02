import { z } from "zod";

export const storageMonitoringTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("primary") }).strict(),
  z.object({ kind: z.literal("logs"), databaseId: z.string().uuid() }).strict(),
]);
export type StorageMonitoringTarget = z.infer<typeof storageMonitoringTargetSchema>;
export const nodeExporterSourceSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[a-zA-Z0-9_.:\[\]-]+$/, "请输入 IP 或主机名，不包含协议、凭据或路径。"),
    port: z.number().int().min(1).max(65535).default(9100),
    tls: z.boolean().default(false),
    mountpoint: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .refine(
        (path) =>
          path.startsWith("/") && !path.split("/").includes("..") && !/[\x00-\x1f\x7f]/.test(path),
        "请输入数据卷的绝对挂载点。",
      ),
  })
  .strict();
export type NodeExporterSource = z.infer<typeof nodeExporterSourceSchema>;
export const storageMonitoringConfigurationSchema = z.object({
  target: storageMonitoringTargetSchema,
  source: nodeExporterSourceSchema.nullable(),
  revision: z.number().int().positive(),
});
export type StorageMonitoringConfiguration = z.infer<typeof storageMonitoringConfigurationSchema>;
export const updateStorageMonitoringSchema = storageMonitoringConfigurationSchema.strict();

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
  storageMonitoringTarget: storageMonitoringTargetSchema.optional(),
});
export type InfrastructureUsage = z.infer<typeof infrastructureUsageSchema>;
export type InfrastructureUsageSample = Pick<InfrastructureUsage, "metrics" | "notes"> & {
  storage?: PostgresStorageCapacity;
  storageMonitoringTarget?: StorageMonitoringTarget;
};
