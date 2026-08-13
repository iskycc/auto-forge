import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PlatformConfigurationConflictError,
  PlatformConfigurationStore,
  loadPlatformConfiguration,
  resolvePlatformDataDirectory,
} from "../src/platform-configuration";

describe("platform configuration store", () => {
  it("creates a standalone Lite configuration and private bootstrap material", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autoforge-config-"));
    const store = new PlatformConfigurationStore(dataDirectory);

    const configuration = store.initialize(new Date("2026-08-11T00:00:00.000Z"));

    expect(configuration.mode).toBe("lite");
    expect(configuration.revision).toBe(1);
    expect(configuration.limits.maxJarBytes).toBe(256 * 1024 * 1024);
    expect(configuration.secrets.masterKey).toHaveLength(44);
    expect(statSync(store.paths.configurationFile).mode & 0o777).toBe(0o600);
    expect(statSync(store.paths.initialAdminTokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(store.paths.initialAdminTokenFile, "utf8").trim()).toBe(
      configuration.secrets.adminBootstrapToken,
    );
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
