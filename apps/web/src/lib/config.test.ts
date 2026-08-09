import { describe, expect, it } from "vitest";

import { loadAppConfig } from "./config";

describe("scheduler configuration", () => {
  it("uses conservative offline defaults", () => {
    const config = loadAppConfig({ NODE_ENV: "test", AUTOFORGE_MODE: "lite" });

    expect(config.scheduler).toEqual({
      maximumCpuUtilizationPercent: 85,
      maximumMemoryUtilizationPercent: 85,
      maximumLoadPerCpu: 1,
      metricsMaximumAgeSeconds: 45,
    });
  });

  it("parses customized thresholds and rejects out-of-range values", () => {
    const config = loadAppConfig({
      NODE_ENV: "test",
      AUTOFORGE_MODE: "lite",
      AUTOFORGE_SCHEDULER_MAX_CPU_PERCENT: "70",
      AUTOFORGE_SCHEDULER_MAX_MEMORY_PERCENT: "75",
      AUTOFORGE_SCHEDULER_MAX_LOAD_PER_CPU: "0.8",
      AUTOFORGE_SCHEDULER_METRICS_MAX_AGE_SECONDS: "60",
    });
    expect(config.scheduler).toEqual({
      maximumCpuUtilizationPercent: 70,
      maximumMemoryUtilizationPercent: 75,
      maximumLoadPerCpu: 0.8,
      metricsMaximumAgeSeconds: 60,
    });
    expect(() =>
      loadAppConfig({
        NODE_ENV: "test",
        AUTOFORGE_MODE: "lite",
        AUTOFORGE_SCHEDULER_MAX_CPU_PERCENT: "101",
      }),
    ).toThrow();
  });
});
