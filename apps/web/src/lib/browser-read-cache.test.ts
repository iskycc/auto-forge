import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserCacheEpoch,
  configureBrowserCacheScope,
  clearBrowserSnapshots,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "./browser-read-cache";

afterEach(() => {
  clearBrowserSnapshots();
  vi.useRealTimers();
});
describe("browser read snapshots", () => {
  it("discards a response that finishes after switching account or invalidating data", () => {
    configureBrowserCacheScope("user-a");
    const epoch = browserCacheEpoch();
    configureBrowserCacheScope("user-b");
    writeBrowserSnapshot("same-api-url", { private: true }, epoch);
    expect(readBrowserSnapshot("same-api-url")).toBeUndefined();
    const nextEpoch = browserCacheEpoch();
    clearBrowserSnapshots();
    writeBrowserSnapshot("same-api-url", { stale: true }, nextEpoch);
    expect(readBrowserSnapshot("same-api-url")).toBeUndefined();
  });
  it("isolates users, project scopes and generations and can clear a logged-out session", () => {
    writeBrowserSnapshot("user-a:project-a:g1", { count: 3 });
    expect(readBrowserSnapshot("user-a:project-a:g1")).toEqual({ count: 3 });
    for (const key of ["user-b:project-a:g1", "user-a:project-b:g1", "user-a:project-a:g2"])
      expect(readBrowserSnapshot(key)).toBeUndefined();
    clearBrowserSnapshots();
    expect(readBrowserSnapshot("user-a:project-a:g1")).toBeUndefined();
  });
  it("expires cached responses and does not retain an oversized payload", () => {
    vi.useFakeTimers();
    writeBrowserSnapshot("small", { count: 1 });
    vi.advanceTimersByTime(300_001);
    expect(readBrowserSnapshot("small")).toBeUndefined();
    writeBrowserSnapshot("large", "x".repeat(25 * 1_024 * 1_024));
    expect(readBrowserSnapshot("large")).toBeUndefined();
  });
});
