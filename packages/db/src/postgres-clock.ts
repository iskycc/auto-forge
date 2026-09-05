import { PlatformClock, type ManagedPlatformClock } from "@autoforge/application";
import type { PostgresDatabaseHandle } from "./postgres-database";

export async function createPostgresClock(
  database: PostgresDatabaseHandle,
  onError: (error: unknown) => void,
): Promise<ManagedPlatformClock> {
  await database.ready;
  const clock = new PlatformClock("postgres", () => performance.now());
  const synchronize = async () => {
    const requestedAtMs = performance.now();
    const client = await database.pool.connect();
    let released = false;
    const timeout = setTimeout(() => {
      released = true;
      client.release(true);
    }, 2_000);
    try {
      const result = await client.query<{ epoch_ms: number }>(
        "SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS epoch_ms",
      );
      clock.synchronize(result.rows[0]?.epoch_ms ?? NaN, requestedAtMs, performance.now());
    } finally {
      clearTimeout(timeout);
      if (!released) client.release();
    }
  };
  // No local-time fallback at startup: every Full process must join the same time basis.
  await synchronize();
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending) return;
    pending = synchronize()
      .catch((error: unknown) => {
        clock.recordFailure(error);
        onError(error);
      })
      .finally(() => {
        pending = undefined;
      });
  }, 5_000);
  timer.unref();
  return Object.assign(clock, {
    close: async () => {
      clearInterval(timer);
      await pending;
    },
  });
}
