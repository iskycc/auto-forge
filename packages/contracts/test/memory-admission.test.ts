import { describe, expect, it } from "vitest";
import { memoryAdmissionModeSchema, updatePlatformConfigurationInputSchema } from "../src/index";

const configuration = {
  revision: 1,
  mode: "lite",
  web: { hostname: "127.0.0.1", port: 3000, publicDashboardRefreshSeconds: 15 },
  limits: {
    maxJarBytes: 1048576,
    testNgTargetJavaVersion: 21,
    runnerClaimRateLimitPerMinute: 120,
    sessionTtlHours: 12,
  },
  scheduler: {
    maximumCpuUtilizationPercent: 85,
    maximumMemoryUtilizationPercent: 85,
    maximumLoadPerCpu: 1,
    metricsMaximumAgeSeconds: 45,
    projectMaximumConcurrency: 128,
    priorityAgingIntervalMinutes: 5,
  },
  worker: { concurrency: 1, healthPort: 3001, metricsEnabled: false, shutdownGraceMs: 30000 },
};

describe("memory admission configuration contract", () => {
  it.each(["reserved", "threshold", "disabled"])(
    "round trips the explicit %s policy",
    (memoryAdmissionMode) => {
      expect(
        updatePlatformConfigurationInputSchema.parse({
          ...configuration,
          scheduler: { ...configuration.scheduler, memoryAdmissionMode },
        }).scheduler.memoryAdmissionMode,
      ).toBe(memoryAdmissionMode);
    },
  );
  it("keeps legacy omission distinct from changing the policy", () => {
    expect(
      updatePlatformConfigurationInputSchema.parse(configuration).scheduler,
    ).not.toHaveProperty("memoryAdmissionMode");
  });
  it("rejects implicit numeric bypasses and unknown strategies", () => {
    expect(
      updatePlatformConfigurationInputSchema.safeParse({
        ...configuration,
        scheduler: { ...configuration.scheduler, maximumMemoryUtilizationPercent: 200 },
      }).success,
    ).toBe(false);
    expect(memoryAdmissionModeSchema.safeParse("automatic").success).toBe(false);
  });
});
