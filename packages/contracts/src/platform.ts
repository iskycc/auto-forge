import { z } from "zod";

const schedulerConfigurationSchema = z.object({
  maximumCpuUtilizationPercent: z.number().min(1).max(100),
  maximumMemoryUtilizationPercent: z.number().min(1).max(100),
  maximumLoadPerCpu: z.number().min(0.1).max(100),
  metricsMaximumAgeSeconds: z.number().int().min(15).max(300),
  projectMaximumConcurrency: z.number().int().min(1).max(10_000),
  priorityAgingIntervalMinutes: z.number().int().min(1).max(1_440),
});

export const updatePlatformConfigurationInputSchema = z.object({
  revision: z.number().int().positive(),
  mode: z.enum(["lite", "full"]),
  web: z.object({
    hostname: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65_535),
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
    maxJarBytes: z.number().int().min(1_048_576).max(268_435_456),
    testNgTargetJavaVersion: z.number().int().min(8).max(100),
    runnerClaimRateLimitPerMinute: z.number().int().min(1).max(10_000),
    sessionTtlHours: z.number().int().min(1).max(168),
    authLoginAttemptsPerWindow: z.number().int().min(1).max(100_000).default(10),
    caseExecutionTimeoutSeconds: z.number().int().min(1).max(86_400).default(600),
    artifactCollectionEnabled: z.boolean().default(true),
  }),
  scheduler: schedulerConfigurationSchema,
  worker: z.object({
    concurrency: z.number().int().min(1).max(256),
    healthPort: z.number().int().min(1).max(65_535),
    metricsEnabled: z.boolean(),
    shutdownGraceMs: z.number().int().min(1_000).max(300_000),
  }),
  full: z
    .object({
      databaseUrl: z.string().trim().min(1).max(4_096).optional(),
      natsServers: z.array(z.string().trim().min(1).max(1_024)).min(1).max(8).optional(),
      redisUrl: z.url().max(2_048).optional(),
      minioEndpoint: z.url().max(2_048).optional(),
      minioAccessKey: z.string().min(1).max(1_024).optional(),
      minioSecretKey: z.string().min(1).max(4_096).optional(),
      minioBucket: z.string().min(3).max(63).optional(),
      minioRegion: z.string().min(1).max(128).optional(),
      databasePoolMax: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
});

export type UpdatePlatformConfigurationInput = z.infer<
  typeof updatePlatformConfigurationInputSchema
>;

export const initializePlatformConfigurationInputSchema = z.object({
  bootstrapToken: z.string().min(32).max(1_024),
  configuration: updatePlatformConfigurationInputSchema,
});

export type InitializePlatformConfigurationInput = z.infer<
  typeof initializePlatformConfigurationInputSchema
>;

export const platformConfigurationViewSchema = updatePlatformConfigurationInputSchema
  .omit({ full: true })
  .extend({
    configurationFile: z.string().min(1),
    fullConfigured: z.boolean(),
    restartRequired: z.boolean(),
    appliedImmediatelyFields: z.array(z.string().min(1).max(120)).max(20).default([]),
    restartRequiredFields: z.array(z.string().min(1).max(120)).max(50).default([]),
  });

export type PlatformConfigurationView = z.infer<typeof platformConfigurationViewSchema>;

export const publicPlatformStatisticsSchema = z.object({
  sourceCount: z.number().int().nonnegative(),
  caseCount: z.number().int().nonnegative(),
  methodCount: z.number().int().nonnegative(),
  enabledMethodCount: z.number().int().nonnegative(),
  runnerCount: z.number().int().nonnegative(),
  onlineRunnerCount: z.number().int().nonnegative(),
  busyRunnerCount: z.number().int().nonnegative(),
  activeBatchCount: z.number().int().nonnegative(),
  completedBatchCount: z.number().int().nonnegative(),
  totalRunCount: z.number().int().nonnegative(),
  succeededRunCount: z.number().int().nonnegative(),
  failedRunCount: z.number().int().nonnegative(),
  successRatePercent: z.number().min(0).max(100),
  generatedAt: z.iso.datetime({ offset: true }),
  refreshSeconds: z.number().int().min(5).max(300),
});

export type PublicPlatformStatistics = z.infer<typeof publicPlatformStatisticsSchema>;
