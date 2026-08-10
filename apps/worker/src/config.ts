import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

const workerEnvironmentSchema = z.object({
  AUTOFORGE_DATABASE_URL: z.string().min(1),
  AUTOFORGE_NATS_SERVERS: z.string().min(1),
  AUTOFORGE_WORKER_ID: z.string().min(1).max(128).optional(),
  AUTOFORGE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(16),
  AUTOFORGE_WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  AUTOFORGE_WORKER_METRICS_ENABLED: z.enum(["0", "1"]).default("0"),
  AUTOFORGE_WORKER_SHUTDOWN_GRACE_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  AUTOFORGE_POSTGRES_MIGRATIONS_DIR: z.string().min(1).optional(),
  AUTOFORGE_SCHEDULER_MAX_CPU_PERCENT: z.coerce.number().min(1).max(100).default(85),
  AUTOFORGE_SCHEDULER_MAX_MEMORY_PERCENT: z.coerce.number().min(1).max(100).default(85),
  AUTOFORGE_SCHEDULER_MAX_LOAD_PER_CPU: z.coerce.number().min(0.1).max(100).default(1),
  AUTOFORGE_SCHEDULER_METRICS_MAX_AGE_SECONDS: z.coerce.number().int().min(15).max(300).default(45),
});

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = workerEnvironmentSchema.parse(environment);
  const natsServers = parsed.AUTOFORGE_NATS_SERVERS.split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (natsServers.length === 0) throw new Error("AUTOFORGE_NATS_SERVERS is empty.");
  const migrationsFolder = parsed.AUTOFORGE_POSTGRES_MIGRATIONS_DIR
    ? resolve(parsed.AUTOFORGE_POSTGRES_MIGRATIONS_DIR)
    : join(findWorkspaceRoot(process.cwd()), "packages", "db", "drizzle", "postgresql");
  return {
    databaseUrl: parsed.AUTOFORGE_DATABASE_URL,
    natsServers,
    workerId: parsed.AUTOFORGE_WORKER_ID ?? `full-worker-${process.pid}`,
    concurrency: parsed.AUTOFORGE_WORKER_CONCURRENCY,
    healthPort: parsed.AUTOFORGE_WORKER_HEALTH_PORT,
    metricsEnabled: parsed.AUTOFORGE_WORKER_METRICS_ENABLED === "1",
    shutdownGraceMs: parsed.AUTOFORGE_WORKER_SHUTDOWN_GRACE_MS,
    migrationsFolder,
    scheduling: {
      maximumCpuUtilizationPercent: parsed.AUTOFORGE_SCHEDULER_MAX_CPU_PERCENT,
      maximumMemoryUtilizationPercent: parsed.AUTOFORGE_SCHEDULER_MAX_MEMORY_PERCENT,
      maximumLoadPerCpu: parsed.AUTOFORGE_SCHEDULER_MAX_LOAD_PER_CPU,
      metricsMaximumAgeSeconds: parsed.AUTOFORGE_SCHEDULER_METRICS_MAX_AGE_SECONDS,
    },
  };
}

function findWorkspaceRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("AUTOFORGE_POSTGRES_MIGRATIONS_DIR is required outside a workspace.");
    }
    current = parent;
  }
}
