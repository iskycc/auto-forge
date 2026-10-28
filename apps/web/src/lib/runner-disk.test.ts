import { describe, expect, it } from "vitest";
import { diskAvailablePercent, isRunnerDiskLow, isRunnerDiskStale } from "./runner-disk";

describe("Runner disk warnings", () => {
  it("warns strictly below 20%, including zero, without rounding before comparison", () => {
    expect(isRunnerDiskLow({ totalBytes: 10000, availableBytes: 1999, path: "/data" })).toBe(true);
    expect(isRunnerDiskLow({ totalBytes: 10000, availableBytes: 2000, path: "/data" })).toBe(false);
    expect(isRunnerDiskLow({ totalBytes: 10000, availableBytes: 2001, path: "/data" })).toBe(false);
    expect(isRunnerDiskLow({ totalBytes: 10000, availableBytes: 0, path: "/data" })).toBe(true);
    expect(diskAvailablePercent({ totalBytes: 10000, availableBytes: 1999, path: "/data" })).toBe(
      19.99,
    );
  });

  it("does not treat missing or invalid legacy capacity as a full disk", () => {
    expect(isRunnerDiskLow(undefined)).toBe(false);
    expect(
      diskAvailablePercent({ totalBytes: 0, availableBytes: 0, path: "/data" }),
    ).toBeUndefined();
    expect(isRunnerDiskLow({ totalBytes: 100, availableBytes: 101, path: "/data" })).toBe(false);
  });

  it("marks offline and old metric samples explicitly", () => {
    const now = "2026-10-28T10:00:00Z";
    expect(isRunnerDiskStale("online", "2026-10-28T09:59:00Z", now)).toBe(false);
    expect(isRunnerDiskStale("online", "2026-10-28T09:58:29Z", now)).toBe(true);
    expect(isRunnerDiskStale("offline", now, now)).toBe(true);
  });
});
