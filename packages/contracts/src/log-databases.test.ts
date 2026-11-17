import { describe, expect, it } from "vitest";
import {
  registerLogDatabaseSchema,
  selectLogDatabaseSchema,
  logDatabaseStatusSchema,
} from "./log-databases";

describe("log database configuration boundaries", () => {
  it("rejects malformed heartbeat timestamps and incomplete capacity samples", () => {
    const valid = {
      heartbeat: {
        status: "healthy",
        checkedAt: "2026-11-17T00:00:00.000Z",
        durationMs: 0,
        detail: "ready",
      },
      capacity: { status: "not_configured", detail: "no exporter" },
    };
    expect(logDatabaseStatusSchema.safeParse(valid).success).toBe(true);
    expect(
      logDatabaseStatusSchema.safeParse({
        ...valid,
        heartbeat: { ...valid.heartbeat, checkedAt: "yesterday" },
      }).success,
    ).toBe(false);
    expect(
      logDatabaseStatusSchema.safeParse({
        ...valid,
        capacity: { status: "available", detail: "no sample" },
      }).success,
    ).toBe(false);
  });
  it.each(["http://host/db", "postgres://host/", "not a URL"])(
    "rejects invalid PostgreSQL target %s",
    (databaseUrl) => {
      expect(registerLogDatabaseSchema.safeParse({ name: "logs", databaseUrl }).success).toBe(
        false,
      );
    },
  );
  it("accepts database URLs and requires a positive switch revision", () => {
    expect(
      registerLogDatabaseSchema.parse({
        name: " 日志库 ",
        databaseUrl: "postgresql://user:password@10.0.0.2:5433/logs",
      }).name,
    ).toBe("日志库");
    expect(selectLogDatabaseSchema.parse({ databaseId: null, revision: 1 }).databaseId).toBeNull();
    expect(selectLogDatabaseSchema.safeParse({ databaseId: null, revision: 0 }).success).toBe(
      false,
    );
  });
});
