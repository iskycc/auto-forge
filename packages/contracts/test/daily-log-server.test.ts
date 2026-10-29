import { describe, expect, it } from "vitest";
import { registerDailyLogServerSchema } from "../src/log-databases";
describe("daily PostgreSQL log server credentials", () => {
  it("accepts named root or postgres administrators without altering their password", () => {
    for (const username of ["root", "postgres"]) {
      const input = registerDailyLogServerSchema.parse({
        name: "日志服务器",
        host: "10.1.1.8",
        username,
        password: " @中文:#% ",
      });
      expect(input).toMatchObject({
        port: 5432,
        maintenanceDatabase: "postgres",
        databasePrefix: "autoforge_logs",
        password: " @中文:#% ",
      });
    }
  });
  it("rejects missing credentials, URL-like hosts and unsafe database prefixes", () => {
    const input = { name: "logs", host: "10.1.1.8", username: "postgres", password: "private" };
    for (const override of [
      { password: "" },
      { host: "postgres://user:secret@host" },
      { databasePrefix: "x;drop" },
      { databasePrefix: "x".repeat(33) },
      { port: 0 },
    ])
      expect(registerDailyLogServerSchema.safeParse({ ...input, ...override }).success).toBe(false);
  });
});
