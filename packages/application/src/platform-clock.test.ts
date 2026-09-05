import { describe, expect, it } from "vitest";
import { PlatformClock } from "./platform-clock";

const epochMs = Date.parse("2026-09-05T00:00:00Z");

function fixture() {
  let monotonicMs = 0;
  const clock = new PlatformClock("postgres", () => monotonicMs);
  const advance = (durationMs: number) => {
    monotonicMs += durationMs;
  };
  return { clock, advance };
}

describe("platform time authority", () => {
  it("requires an initial sample and advances independently of the host wall clock", () => {
    const { clock, advance } = fixture();
    expect(() => clock.now()).toThrow("统一时间基准");
    clock.synchronize(epochMs, 0, 0);
    advance(600_000);
    // A local clock has no external source or freshness deadline.
    const local = new PlatformClock("local", () => 600_000);
    local.synchronize(epochMs, 0, 0);
    expect(local.now().getTime()).toBe(epochMs + 600_000);
    expect(() => clock.now()).toThrow("统一时间基准");
  });

  it("accounts for round trip delay and gives differently skewed nodes the same time", () => {
    const first = fixture();
    const second = fixture();
    first.advance(20);
    second.advance(20);
    first.clock.synchronize(epochMs + 10, 0, 20);
    second.clock.synchronize(epochMs + 10, 0, 20);
    expect(first.clock.now().getTime()).toBe(epochMs + 20);
    expect(second.clock.now()).toEqual(first.clock.now());
  });

  it("holds time through source loss for 120 seconds and recovers after a fresh sample", () => {
    const { clock, advance } = fixture();
    clock.synchronize(epochMs, 0, 0);
    clock.recordFailure(new Error("database disconnected"));
    advance(119_000);
    expect(clock.now().getTime()).toBe(epochMs + 119_000);
    expect(clock.status().state).toBe("holdover");
    advance(1_000);
    expect(clock.status().state).toBe("unavailable");
    expect(() => clock.now()).toThrow("统一时间基准");
    clock.synchronize(epochMs + 120_000, 120_000, 120_000);
    expect(clock.status().state).toBe("synchronized");
  });

  it.each([-600_000, 600_000])(
    "rejects a source clock jump of %i ms without jumping leases",
    (jumpMs) => {
      const { clock, advance } = fixture();
      clock.synchronize(epochMs, 0, 0);
      advance(5_000);
      expect(() => clock.synchronize(epochMs + 5_000 + jumpMs, 5_000, 5_000)).toThrow("跳变");
      expect(clock.now().getTime()).toBe(epochMs + 5_000);
      advance(115_000);
      expect(() => clock.now()).toThrow("统一时间基准");
    },
  );

  it("rejects slow or invalid samples and slews small corrections without moving backwards", () => {
    const { clock, advance } = fixture();
    expect(() => clock.synchronize(NaN, 0, 0)).toThrow();
    expect(() => clock.synchronize(epochMs, 0, 2_001)).toThrow();
    clock.synchronize(epochMs, 0, 0);
    advance(5_000);
    clock.synchronize(epochMs + 4_000, 5_000, 5_000);
    expect(clock.now().getTime()).toBe(epochMs + 5_000);
    advance(1_000);
    expect(clock.now().getTime()).toBe(epochMs + 5_950);
  });
});
