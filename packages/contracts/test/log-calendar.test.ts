import { describe, expect, it } from "vitest";
import { beijingLogDay, dailyLogDatabaseName } from "../src/log-calendar";

describe("Beijing log storage dates", () => {
  it("switches database days at Beijing midnight without depending on host time zone", () => {
    expect(beijingLogDay("2026-10-27T15:59:59.999Z")).toBe("2026-10-27");
    expect(beijingLogDay("2026-10-27T16:00:00.000Z")).toBe("2026-10-28");
    expect(beijingLogDay("2026-10-28T00:00:00+08:00")).toBe("2026-10-28");
  });
  it("keeps deterministic, bounded database names and rejects SQL-like or invalid dates", () => {
    expect(dailyLogDatabaseName("autoforge_logs", "1234abcd", "2026-10-28")).toBe(
      "autoforge_logs_1234abcd_20261028",
    );
    for (const [prefix, day] of [
      ["logs;DROP DATABASE postgres", "2026-10-28"],
      ["logs", "2026-02-30"],
      ["logs", "2026-10-28;drop"],
    ])
      expect(() => dailyLogDatabaseName(prefix!, "1234abcd", day!)).toThrow();
    expect(() => beijingLogDay("invalid")).toThrow();
  });
});
