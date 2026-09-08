import { describe, expect, it, vi } from "vitest";
import { AnalyticsFactRefresh } from "./analytics-fact-refresh";

describe("analytics fact refresh scheduling", () => {
  it("backs off empty history scans to 30 seconds and drains new facts at the active interval", async () => {
    let now = 0;
    const rebuild = vi.fn(async () => 0);
    const refresh = new AnalyticsFactRefresh(rebuild, vi.fn(), () => now);
    for (const dueAt of [0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000]) {
      now = dueAt;
      const calls = rebuild.mock.calls.length;
      await refresh.refreshIfDue();
      expect(rebuild).toHaveBeenCalledTimes(calls + 1);
      now += 500;
      await refresh.refreshIfDue();
      expect(rebuild).toHaveBeenCalledTimes(calls + 1);
    }
    rebuild.mockResolvedValue(100);
    now = 91_000;
    await refresh.refreshIfDue();
    const activeCalls = rebuild.mock.calls.length;
    now += 1_000;
    await refresh.refreshIfDue();
    expect(rebuild).toHaveBeenCalledTimes(activeCalls + 1);
  });

  it("reports failures, backs off retries, and lets the caller continue building page snapshots", async () => {
    let now = 0;
    const failure = new Error("database lock conflict");
    const rebuild = vi.fn().mockRejectedValue(failure);
    const errors = vi.fn();
    const refresh = new AnalyticsFactRefresh(rebuild, errors, () => now);
    await expect(refresh.refreshIfDue()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(failure);
    now = 500;
    await refresh.refreshIfDue();
    expect(rebuild).toHaveBeenCalledOnce();
    now = 1_000;
    await refresh.refreshIfDue();
    expect(rebuild).toHaveBeenCalledTimes(2);
    now = 2_000;
    await refresh.refreshIfDue();
    expect(rebuild).toHaveBeenCalledTimes(2);
    rebuild.mockResolvedValue(100);
    now = 3_000;
    await refresh.refreshIfDue();
    expect(rebuild).toHaveBeenCalledTimes(3);
  });
});
