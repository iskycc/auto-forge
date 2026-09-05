// Explicit bridge between the bundled Next services and the self-hosted gateways.
const runtime = globalThis as typeof globalThis & {
  __autoforgePlatformClock?: { now(): Date };
};

export function registerPlatformClock(clock: { now(): Date }): void {
  runtime.__autoforgePlatformClock = clock;
}

export function platformClockNow(): Date {
  if (!runtime.__autoforgePlatformClock) throw new Error("Platform clock is not ready.");
  return runtime.__autoforgePlatformClock.now();
}
