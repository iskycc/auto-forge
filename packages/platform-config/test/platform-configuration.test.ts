import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  PlatformConfigurationConflictError,
  PlatformConfigurationStore,
  loadPlatformConfiguration,
  resolvePlatformDataDirectory,
} from "../src/platform-configuration";

describe("platform configuration store", () => {
  it("loads with native Node.js type stripping without a bundler or TypeScript loader", () => {
    const moduleUrl = new URL("../src/platform-configuration.ts", import.meta.url).href;
    const script = `import { PLATFORM_CONFIGURATION_SCHEMA_VERSION } from ${JSON.stringify(moduleUrl)}; process.stdout.write(String(PLATFORM_CONFIGURATION_SCHEMA_VERSION));`;
    expect(
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8",
      }),
    ).toBe("1");
  });
  it("refreshes scheduler snapshots across stores without reparsing an unchanged file", () => {
    const directory = mkdtempSync(join(tmpdir(), "live-scheduler-"));
    const writer = new PlatformConfigurationStore(directory);
    const initial = writer.initialize();
    const reader = new PlatformConfigurationStore(directory);
    const read = vi.spyOn(reader, "read");
    const first = reader.readScheduler();
    first.memoryAdmissionMode = "disabled";
    expect(reader.readScheduler().memoryAdmissionMode).toBe("reserved");
    expect(read).toHaveBeenCalledTimes(1);
    writer.replace(
      { ...initial, scheduler: { ...initial.scheduler, memoryAdmissionMode: "threshold" } },
      initial.revision,
    );
    expect(reader.readScheduler().memoryAdmissionMode).toBe("threshold");
    expect(read).toHaveBeenCalledTimes(2);
    writeFileSync(writer.paths.configurationFile, "{invalid", { mode: 0o600 });
    expect(() => reader.readScheduler()).toThrow();
    writeFileSync(writer.paths.configurationFile, JSON.stringify(initial), { mode: 0o600 });
    expect(reader.readScheduler().memoryAdmissionMode).toBe("reserved");
  });

  it("creates a standalone Lite configuration and private bootstrap material", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autoforge-config-"));
    const store = new PlatformConfigurationStore(dataDirectory);

    const configuration = store.initialize(new Date("2026-08-11T00:00:00.000Z"));

    expect(configuration.mode).toBe("lite");
    expect(configuration.web.timeZone).toBe("Asia/Shanghai");
    expect(configuration.revision).toBe(1);
    expect(configuration.limits.maxJarBytes).toBe(256 * 1024 * 1024);
    expect(configuration.limits.ddtImportFileLimit).toBe(200);
    expect(configuration.limits.ddtImportZipSpreadsheetLimit).toBe(200);
    expect(configuration.secrets.masterKey).toHaveLength(44);
    expect(statSync(store.paths.configurationFile).mode & 0o777).toBe(0o600);
    expect(statSync(store.paths.initialAdminTokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(store.paths.initialAdminTokenFile, "utf8").trim()).toBe(
      configuration.secrets.adminBootstrapToken,
    );
  });

  it("keeps old configuration files readable with platform defaults", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autoforge-config-"));
    const store = new PlatformConfigurationStore(dataDirectory);
    store.initialize(new Date("2026-08-11T00:00:00.000Z"));
    const legacy = JSON.parse(readFileSync(store.paths.configurationFile, "utf8")) as {
      web: { timeZone?: string };
      limits: { ddtImportFileLimit?: number; ddtImportZipSpreadsheetLimit?: number };
    };
    delete legacy.web.timeZone;
    delete legacy.limits.ddtImportFileLimit;
    delete legacy.limits.ddtImportZipSpreadsheetLimit;
    writeFileSync(store.paths.configurationFile, JSON.stringify(legacy), { mode: 0o600 });

    expect(store.read().web.timeZone).toBe("Asia/Shanghai");
    expect(store.read().limits.ddtImportFileLimit).toBe(200);
    expect(store.read().limits.ddtImportZipSpreadsheetLimit).toBe(200);
  });

  it("defaults legacy files to reserved mode and persists every explicit memory strategy", () => {
    const store = new PlatformConfigurationStore(mkdtempSync(join(tmpdir(), "memory-mode-")));
    store.initialize();
    const legacy = JSON.parse(readFileSync(store.paths.configurationFile, "utf8")) as {
      scheduler: { memoryAdmissionMode?: string };
    };
    delete legacy.scheduler.memoryAdmissionMode;
    writeFileSync(store.paths.configurationFile, JSON.stringify(legacy), { mode: 0o600 });
    expect(store.read().scheduler.memoryAdmissionMode).toBe("reserved");
    for (const memoryAdmissionMode of ["threshold", "disabled", "reserved"] as const) {
      const current = store.read();
      store.replace(
        { ...current, scheduler: { ...current.scheduler, memoryAdmissionMode } },
        current.revision,
      );
      expect(store.read().scheduler.memoryAdmissionMode).toBe(memoryAdmissionMode);
    }
    const current = store.read();
    expect(() =>
      store.replace(
        { ...current, scheduler: { ...current.scheduler, maximumMemoryUtilizationPercent: 200 } },
        current.revision,
      ),
    ).toThrow();
  });

  it("uses revision conditions and preserves generated secrets", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autoforge-config-"));
    const store = new PlatformConfigurationStore(dataDirectory);
    const current = store.initialize(new Date("2026-08-11T00:00:00.000Z"));

    const updated = store.replace(
      {
        ...current,
        web: { ...current.web, port: 3100 },
      },
      1,
      new Date("2026-08-11T00:01:00.000Z"),
    );

    expect(updated.revision).toBe(2);
    expect(updated.web.port).toBe(3100);
    expect(updated.secrets).toEqual(current.secrets);
    expect(() => store.replace(updated, 1)).toThrow(PlatformConfigurationConflictError);
  });

  it("persists separate external and Runner addresses and rejects unrelated URL schemes", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autoforge-config-"));
    const store = new PlatformConfigurationStore(dataDirectory);
    const current = store.initialize(new Date("2026-08-11T00:00:00.000Z"));

    const updated = store.replace(
      {
        ...current,
        web: {
          ...current.web,
          publicBaseUrl: "https://autoforge.example.test",
          runnerBaseUrl: "http://10.20.30.40:3000",
        },
      },
      current.revision,
    );

    expect(updated.web.publicBaseUrl).toBe("https://autoforge.example.test");
    expect(updated.web.runnerBaseUrl).toBe("http://10.20.30.40:3000");
    expect(() =>
      store.replace(
        {
          ...updated,
          web: { ...updated.web, runnerBaseUrl: "ftp://10.20.30.40" },
        },
        updated.revision,
      ),
    ).toThrow("HTTP 或 HTTPS");
  });

  it("accepts IANA time zones and rejects unknown values", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autoforge-config-"));
    const store = new PlatformConfigurationStore(dataDirectory);
    const current = store.initialize(new Date("2026-08-11T00:00:00.000Z"));

    const updated = store.replace(
      { ...current, web: { ...current.web, timeZone: "America/New_York" } },
      current.revision,
    );
    expect(updated.web.timeZone).toBe("America/New_York");
    expect(() =>
      store.replace(
        { ...updated, web: { ...updated.web, timeZone: "Mars/Olympus" } },
        updated.revision,
      ),
    ).toThrow("IANA 时区");
  });

  it("recovers when the private token was persisted before platform.json", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autoforge-config-"));
    const store = new PlatformConfigurationStore(dataDirectory);
    mkdirSync(store.paths.configurationDirectory, { recursive: true, mode: 0o700 });
    const recoveredToken = "r".repeat(43);
    writeFileSync(store.paths.initialAdminTokenFile, `${recoveredToken}\n`, { mode: 0o600 });

    const configuration = store.initialize(new Date("2026-08-11T00:00:00.000Z"));

    expect(configuration.secrets.adminBootstrapToken).toBe(recoveredToken);
  });

  it("loads runtime paths without reading process environment variables", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autoforge-config-"));
    const runtime = loadPlatformConfiguration({
      dataDirectory,
      workspaceRoot: "/workspace",
      now: new Date("2026-08-11T00:00:00.000Z"),
    });

    expect(runtime.databasePath).toBe(join(dataDirectory, "db", "autoforge.sqlite"));
    expect(runtime.migrationsFolder).toBe("/workspace/packages/db/drizzle/sqlite");
  });

  it("accepts an explicit data directory command argument", () => {
    expect(resolvePlatformDataDirectory(["--data-dir", "./state"], "/srv/autoforge")).toBe(
      "/srv/autoforge/state",
    );
    expect(() => resolvePlatformDataDirectory(["--data-dir"], "/srv/autoforge")).toThrow();
  });
});
