import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresConnectionPoolCache } from "../src/postgres-connection-pool-cache";
function fixture(maximum = 2) {
  const pools: Pool[] = [];
  const create = vi.fn(() => {
    const pool = {
      end: vi.fn(async () => undefined),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    } as unknown as Pool;
    pools.push(pool);
    return pool;
  });
  return { cache: new PostgresConnectionPoolCache(create, maximum), create, pools };
}
describe("bounded PostgreSQL administration pools", () => {
  it("reuses the same connection pool and evicts the least recently used idle pool", async () => {
    const { cache, create, pools } = fixture();
    await cache.withConnection("one", async (pool) => expect(pool).toBe(pools[0]));
    await cache.withConnection("two", async () => undefined);
    await cache.withConnection("one", async (pool) => expect(pool).toBe(pools[0]));
    await cache.withConnection("three", async () => undefined);
    expect(create).toHaveBeenCalledTimes(3);
    expect(pools[1]!.end).toHaveBeenCalledOnce();
    expect(pools[0]!.end).not.toHaveBeenCalled();
    expect(cache.snapshot()).toEqual({ pools: 2, connections: 2, idle: 2, waiting: 0 });
    await cache.close();
    expect(pools[0]!.end).toHaveBeenCalledOnce();
    expect(pools[2]!.end).toHaveBeenCalledOnce();
  });
  it("never retires a pool held by an operation and releases references after failure", async () => {
    const { cache, create } = fixture(1);
    await expect(
      cache.withConnection("one", async () => {
        expect(await cache.retire("one")).toBe(false);
        await expect(cache.withConnection("two", async () => undefined)).rejects.toMatchObject({
          code: "PLATFORM_LOG_BUSY",
        });
        throw new Error("query failed");
      }),
    ).rejects.toThrow("query failed");
    expect(create).toHaveBeenCalledOnce();
    expect(await cache.retire("one")).toBe(true);
    expect(await cache.retire("unknown")).toBe(true);
    await cache.close();
  });
  it("coalesces concurrent allocations and does not poison admission after creation fails", async () => {
    const { cache, create } = fixture();
    create.mockImplementationOnce(() => {
      throw new Error("bad configuration");
    });
    await expect(cache.withConnection("one", async () => undefined)).rejects.toThrow(
      "bad configuration",
    );
    await Promise.all(
      Array.from({ length: 20 }, () => cache.withConnection("one", async () => undefined)),
    );
    expect(create).toHaveBeenCalledTimes(2);
    await cache.close();
    await expect(cache.withConnection("one", async () => undefined)).rejects.toMatchObject({
      code: "PLATFORM_LOG_BUSY",
    });
  });
  it("closes outside admission so an in-flight nested operation observes shutdown", async () => {
    const { cache, pools } = fixture();
    let releaseEnd!: () => void;
    await cache.withConnection("one", async () => undefined);
    vi.mocked(pools[0]!.end).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseEnd = resolve;
        }),
    );
    const closing = cache.close();
    await vi.waitFor(() => expect(pools[0]!.end).toHaveBeenCalledOnce());
    await expect(cache.withConnection("two", async () => undefined)).rejects.toMatchObject({
      code: "PLATFORM_LOG_BUSY",
    });
    releaseEnd();
    await closing;
  });
});
