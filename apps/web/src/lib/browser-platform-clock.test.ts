import { describe, expect, it, vi } from "vitest";
import { BrowserPlatformClock } from "./browser-platform-clock";

describe("browser execution timing", () => {
  it.each([-600_000, 600_000])(
    "ignores a browser wall clock offset of %i ms and later clock steps",
    (offsetMs) => {
      const serverTime = Date.parse("2026-09-05T00:00:00Z");
      let monotonicMs = 0;
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(serverTime + offsetMs);
      try {
        const clock = new BrowserPlatformClock(serverTime, () => monotonicMs);
        expect(clock.now() - serverTime).toBe(0);
        monotonicMs += 3_000;
        wallClock.mockReturnValue(serverTime - offsetMs);
        expect(clock.now() - serverTime).toBe(3_000);
        expect(serverTime + 60_000 - clock.now()).toBe(57_000);
      } finally {
        wallClock.mockRestore();
      }
    },
  );

  it("compensates for network delay when refreshing the platform time", () => {
    let monotonicMs = 0;
    const clock = new BrowserPlatformClock(100_000, () => monotonicMs);
    monotonicMs = 100;
    clock.synchronize(100_050, 0, 100);
    monotonicMs = 1_100;
    expect(clock.now()).toBe(101_100);
    expect(() => clock.synchronize(NaN, 0, 100)).toThrow();
  });
});
