import { describe, expect, it } from "vitest";
import { registerLogDatabaseSchema, selectLogDatabaseSchema } from "./log-databases";

describe("log database configuration boundaries", () => {
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
