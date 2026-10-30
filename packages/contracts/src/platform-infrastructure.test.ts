import { describe, expect, it } from "vitest";
import {
  infrastructureConnectionUrl,
  logMaintenanceUsesBusinessDatabase,
  platformInfrastructureCheckSchema,
} from "./platform-infrastructure";

describe("guided infrastructure connections", () => {
  it("rejects the same physical maintenance and business database regardless of credentials", () => {
    const parsed = platformInfrastructureCheckSchema.parse({
      component: "logs",
      connection: {
        name: "logs",
        host: "DB.internal",
        username: "postgres",
        password: "admin-password",
        maintenanceDatabase: "autoforge",
      },
    });
    if (parsed.component !== "logs") throw new Error("Unexpected component");
    expect(
      logMaintenanceUsesBusinessDatabase(
        "postgresql://app:other@db.internal/autoforge",
        parsed.connection,
      ),
    ).toBe(true);
    expect(
      logMaintenanceUsesBusinessDatabase(
        "postgresql://app:other@db.internal/business",
        parsed.connection,
      ),
    ).toBe(false);
    expect(
      logMaintenanceUsesBusinessDatabase(
        "postgresql://app:other@db.internal:5433/autoforge",
        parsed.connection,
      ),
    ).toBe(false);
  });
  it("round-trips reserved characters and IPv6 without corrupting credentials", () => {
    const target = platformInfrastructureCheckSchema.parse({
      component: "postgres",
      connection: {
        host: "::1",
        username: "user@name",
        password: "密碼@:/?#%+ ",
        database: "test-db",
        sslMode: "require",
      },
    });
    if (target.component !== "postgres") throw new Error("Unexpected component");
    const url = new URL(infrastructureConnectionUrl(target));
    expect(url.hostname).toBe("[::1]");
    expect(url.port).toBe("5432");
    expect(decodeURIComponent(url.username)).toBe(target.connection.username);
    expect(decodeURIComponent(url.password)).toBe(target.connection.password);
    expect(url.searchParams.get("sslmode")).toBe("require");
  });
  it.each(["https://host", "host:5432", "host/db", "user@host", "host?x=1", "host\\path"])(
    "rejects an address containing URL fragments: %s",
    (host) => {
      expect(
        platformInfrastructureCheckSchema.safeParse({ component: "redis", connection: { host } })
          .success,
      ).toBe(false);
    },
  );
  it("retains Redis authentication, logical database and TLS", () => {
    const target = platformInfrastructureCheckSchema.parse({
      component: "redis",
      connection: {
        host: "cache.internal",
        username: "default",
        password: "a@b:c",
        database: 3,
        tls: true,
      },
    });
    if (target.component !== "redis") throw new Error("Unexpected component");
    const url = new URL(infrastructureConnectionUrl(target));
    expect(url.protocol).toBe("rediss:");
    expect(decodeURIComponent(url.password)).toBe("a@b:c");
    expect(url.pathname).toBe("/3");
  });
});
