import type { PersistedPlatformConfiguration } from "@autoforge/platform-config";
import { describe, expect, it } from "vitest";

import { mergePlatformConfiguration, platformConfigurationView } from "./platform-configuration";

describe("platform configuration mapping", () => {
  it("never returns persisted secrets in the administrator view", () => {
    const view = platformConfigurationView(configuration(), "/data/config/platform.json");

    expect(view.fullConfigured).toBe(false);
    expect(view).not.toHaveProperty("secrets");
  });

  it("requires complete Full infrastructure settings on first enable", () => {
    const current = configuration();
    expect(() =>
      mergePlatformConfiguration(current, {
        revision: 1,
        mode: "full",
        web: current.web,
        limits: current.limits,
        scheduler: current.scheduler,
        worker: current.worker,
      }),
    ).toThrow(/完整配置/);
  });

  it("preserves secrets when an administrator leaves credential fields blank", () => {
    const current = configuration({
      full: {
        databaseUrl: "postgresql://autoforge:secret@postgres/autoforge",
        natsServers: ["nats://nats:4222"],
        redisUrl: "redis://redis:6379",
        minio: {
          endpoint: "http://minio:9000",
          accessKey: "autoforge",
          secretKey: "secret",
          bucket: "autoforge-objects",
          region: "us-east-1",
        },
      },
    });
    const merged = mergePlatformConfiguration(current, {
      revision: 1,
      mode: "full",
      web: current.web,
      limits: current.limits,
      scheduler: current.scheduler,
      worker: current.worker,
    });

    expect(merged.full).toEqual(current.full);
  });
});

function configuration(
  overrides: Partial<PersistedPlatformConfiguration> = {},
): PersistedPlatformConfiguration {
  return {
    schemaVersion: 1,
    revision: 1,
    mode: "lite",
    web: { hostname: "0.0.0.0", port: 3000, publicDashboardRefreshSeconds: 15 },
    limits: {
      maxJarBytes: 33_554_432,
      testNgTargetJavaVersion: 21,
      runnerClaimRateLimitPerMinute: 120,
      sessionTtlHours: 12,
      authLoginAttemptsPerWindow: 10,
      caseExecutionTimeoutSeconds: 600,
      artifactCollectionEnabled: true,
    },
    scheduler: {
      maximumCpuUtilizationPercent: 85,
      maximumMemoryUtilizationPercent: 85,
      maximumLoadPerCpu: 1,
      metricsMaximumAgeSeconds: 45,
      projectMaximumConcurrency: 128,
      priorityAgingIntervalMinutes: 5,
    },
    worker: {
      concurrency: 16,
      healthPort: 3001,
      metricsEnabled: false,
      shutdownGraceMs: 30_000,
    },
    secrets: {
      runnerBootstrapToken: "runner-bootstrap-token-00000000000000",
      adminBootstrapToken: "admin-bootstrap-token-000000000000000",
      terminalAccessToken: "terminal-access-token-000000000000000",
      masterKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}
