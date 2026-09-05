import { PlatformClock, type ManagedPlatformClock } from "@autoforge/application";

export function createLocalClock(): ManagedPlatformClock {
  const clock = new PlatformClock("local", () => performance.now());
  const elapsedMs = performance.now();
  // Node's time origin is shared by its worker threads and survives OS clock steps.
  clock.synchronize(performance.timeOrigin + elapsedMs, elapsedMs, elapsedMs);
  return Object.assign(clock, { close: async () => {} });
}
