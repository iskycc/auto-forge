import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalClock } from "../src/local-clock";
import { createPostgresClock } from "../src/postgres-clock";
import { createPostgresDatabase } from "../src/postgres-database";
import { signNodeLogRequest, verifyNodeLogRequest } from "../src/platform-node-transport";

afterEach(() => vi.useRealTimers());

describe("Lite platform time", () => {
  it("shares the process time origin and survives forward and backward host clock steps", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = createLocalClock();
    vi.setSystemTime(new Date("2000-01-01T00:00:00Z"));
    const second = createLocalClock();
    expect(Math.abs(first.now().getTime() - second.now().getTime())).toBeLessThan(100);
    const before = first.now().getTime();
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    expect(first.now().getTime() - before).toBeLessThan(100);
    await Promise.all([first.close(), second.close()]);
  });
});

describe.skipIf(!process.env.AUTOFORGE_TEST_POSTGRES_URL)("Full PostgreSQL time authority", () => {
  it("aligns three skewed nodes and authenticates their requests using database time", async () => {
    const database = createPostgresDatabase({
      connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
      poolMax: 2,
    });
    const clocks: Array<Awaited<ReturnType<typeof createPostgresClock>>> = [];
    try {
      await database.ready;
      const result = await database.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const databaseEpochMs = result.rows[0]!.now.getTime();
      vi.useFakeTimers({ toFake: ["Date"] });
      for (const offsetMs of [-600_000, 600_000, 1_200_000]) {
        vi.setSystemTime(databaseEpochMs + offsetMs);
        const clock = await createPostgresClock(database, (error) => {
          throw error;
        });
        clocks.push(clock);
        expect(Math.abs(clock.now().getTime() - databaseEpochMs)).toBeLessThan(2_000);
      }
      const source = randomUUID();
      const target = randomUUID();
      const body = JSON.stringify({ operation: "list", batchId: randomUUID() });
      const secret = "test-clock-authority-key".repeat(3);
      const headers = new Headers(
        signNodeLogRequest(secret, source, target, body, clocks[0]!.now().getTime()),
      );
      expect(
        verifyNodeLogRequest(secret, target, headers, body, clocks[1]!.now().getTime())
          .sourceNodeId,
      ).toBe(source);
      // The previous implementation rejects the exact same request using this host's time.
      expect(() => verifyNodeLogRequest(secret, target, headers, body, Date.now())).toThrow(
        "认证失败",
      );
      vi.setSystemTime(databaseEpochMs - 3_600_000);
      expect(Math.abs(clocks[2]!.now().getTime() - clocks[0]!.now().getTime())).toBeLessThan(100);
    } finally {
      await Promise.all(clocks.map((clock) => clock.close()));
      await database.close();
    }
  });
});
