import type { PersistedPlatformConfiguration } from "@autoforge/platform-config";
import { describe, expect, it } from "vitest";

import {
  mergePlatformConfiguration,
  platformConfigurationActivation,
  platformConfigurationView,
  runnerControlPlaneUrl,
} from "./platform-configuration";

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
        databasePoolMax: 10,
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

  it("preserves the configured time zone for older v1 clients that omit it", () => {
    const current = configuration({
      web: {
        hostname: "0.0.0.0",
        port: 3000,
        timeZone: "America/New_York",
        publicDashboardRefreshSeconds: 15,
      },
    });
    const legacyWeb = {
      hostname: current.web.hostname,
      port: current.web.port,
      publicDashboardRefreshSeconds: current.web.publicDashboardRefreshSeconds,
    };

    const merged = mergePlatformConfiguration(current, {
      revision: current.revision,
      mode: current.mode,
      web: legacyWeb,
      limits: current.limits,
      scheduler: current.scheduler,
      worker: current.worker,
    });

    expect(merged.web.timeZone).toBe("America/New_York");
  });

  it("distinguishes immediately applied settings from restart-only process settings", () => {
    const current = configuration();
    const saved = configuration({
      web: {
        ...current.web,
        publicBaseUrl: "https://new.autoforge.test",
        runnerBaseUrl: "http://10.20.30.40:3000",
        port: 3200,
        timeZone: "UTC",
      },
      limits: { ...current.limits, artifactCollectionEnabled: false, maxJarBytes: 67_108_864 },
    });

    expect(platformConfigurationActivation(current, saved)).toEqual({
      appliedImmediatelyFields: ["外部访问地址", "内部访问地址", "平台时区", "产物收集"],
      restartRequiredFields: ["HTTP 端口", "容量与会话限制"],
    });
  });

  it("uses the internal Runner address and falls back to the external address", () => {
    expect(
      runnerControlPlaneUrl({
        publicBaseUrl: "https://autoforge.example.test",
        runnerBaseUrl: "http://10.20.30.40:3000",
      }),
    ).toBe("http://10.20.30.40:3000");
    expect(runnerControlPlaneUrl({ publicBaseUrl: "https://autoforge.example.test" })).toBe(
      "https://autoforge.example.test",
    );
  });

  it("preserves an internal address omitted by old clients and supports explicit clearing", () => {
    const current = configuration({
      web: {
        ...configuration().web,
        publicBaseUrl: "https://autoforge.example.test",
        runnerBaseUrl: "http://10.20.30.40:3000",
      },
    });
    const legacyInput = {
      revision: current.revision,
      mode: current.mode,
      web: {
        hostname: current.web.hostname,
        port: current.web.port,
        timeZone: current.web.timeZone,
        publicBaseUrl: current.web.publicBaseUrl,
        publicDashboardRefreshSeconds: current.web.publicDashboardRefreshSeconds,
      },
      limits: current.limits,
      scheduler: current.scheduler,
      worker: current.worker,
    };

    expect(mergePlatformConfiguration(current, legacyInput).web.runnerBaseUrl).toBe(
      "http://10.20.30.40:3000",
    );
    expect(
      mergePlatformConfiguration(current, {
        ...legacyInput,
        web: { ...legacyInput.web, runnerBaseUrl: null },
      }).web.runnerBaseUrl,
    ).toBeUndefined();
  });
});

function configuration(
  overrides: Partial<PersistedPlatformConfiguration> = {},
): PersistedPlatformConfiguration {
  return {
    schemaVersion: 1,
    revision: 1,
    mode: "lite",
    web: {
      hostname: "0.0.0.0",
      port: 3000,
      timeZone: "Asia/Shanghai",
      publicDashboardRefreshSeconds: 15,
    },
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
