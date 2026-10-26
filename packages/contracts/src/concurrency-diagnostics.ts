import { z } from "zod";

const count = z.number().int().nonnegative();
const reason = z.object({ code: z.string().min(1).max(80), message: z.string().max(2048) });
export const concurrencyDiagnosticsSchema = z.object({
  batchId: z.string().min(1),
  sampledAt: z.iso.datetime(),
  targetConcurrency: count.nullable(),
  runningRuns: count,
  assignedRuns: count,
  readyRuns: count,
  heldRuns: count,
  projectActiveRuns: count,
  projectMaximumConcurrency: count,
  availableNodeSlots: count,
  omittedNodes: count,
  thresholds: z.object({
    maximumCpuUtilizationPercent: z.number(),
    maximumMemoryUtilizationPercent: z.number(),
    maximumLoadPerCpu: z.number(),
  }),
  metricsMaximumAgeSeconds: count,
  reasons: z.array(reason).max(32),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        maxConcurrency: count,
        reportedBusySlots: count,
        reservedSlots: count,
        batchReservedSlots: count,
        otherReservedSlots: count,
        availableSlots: count,
        concurrencyAvailableSlots: count,
        memoryAvailableSlots: count.nullable(),
        memoryPerAttemptBytes: count,
        systemMemoryReserveBytes: count.nullable(),
        memoryExecutionCreditBytes: count.nullable().optional(),
        memoryReservedGrowthBytes: count.nullable().optional(),
        metrics: z
          .object({
            cpuUtilizationPercent: z.number(),
            memoryUtilizationPercent: z.number(),
            memoryTotalBytes: count.optional(),
            memoryAvailableBytes: count.optional(),
            observedAt: z.iso.datetime(),
          })
          .nullable(),
        reasons: z.array(reason).max(32),
      }),
    )
    .max(64),
});

export type ConcurrencyDiagnostics = z.infer<typeof concurrencyDiagnosticsSchema>;
