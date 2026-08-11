import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { describe, expect, it } from "vitest";

import { loadAppConfig } from "./config";

describe("persisted application configuration", () => {
  it("uses conservative standalone defaults", () => {
    const dataDirectory = temporaryDataDirectory();
    const config = loadAppConfig({ dataDirectory, workspaceRoot: "/workspace" });

    expect(config.mode).toBe("lite");
    expect(config.scheduler).toEqual({
      maximumCpuUtilizationPercent: 85,
      maximumMemoryUtilizationPercent: 85,
      maximumLoadPerCpu: 1,
      metricsMaximumAgeSeconds: 45,
      projectMaximumConcurrency: 128,
      priorityAgingIntervalMinutes: 5,
    });
    expect(config.testNgTargetJavaVersion).toBe(21);
    expect(config.masterKey).toHaveLength(44);
  });

  it("loads administrator-managed limits instead of process environment variables", () => {
    const dataDirectory = temporaryDataDirectory();
    const store = new PlatformConfigurationStore(dataDirectory);
    const current = store.initialize();
    store.replace(
      {
        ...current,
        limits: { ...current.limits, testNgTargetJavaVersion: 17 },
        scheduler: {
          maximumCpuUtilizationPercent: 70,
          maximumMemoryUtilizationPercent: 75,
          maximumLoadPerCpu: 0.8,
          metricsMaximumAgeSeconds: 60,
          projectMaximumConcurrency: 32,
          priorityAgingIntervalMinutes: 10,
        },
      },
      current.revision,
    );

    const config = loadAppConfig({ dataDirectory, workspaceRoot: "/workspace" });
    expect(config.testNgTargetJavaVersion).toBe(17);
    expect(config.scheduler.maximumCpuUtilizationPercent).toBe(70);
    expect(config.scheduler.metricsMaximumAgeSeconds).toBe(60);
  });
});

function temporaryDataDirectory(): string {
  return mkdtempSync(join(tmpdir(), "autoforge-web-config-"));
}
