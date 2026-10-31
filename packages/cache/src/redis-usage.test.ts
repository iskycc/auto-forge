import { describe, expect, it, vi } from "vitest";
import { RedisCache } from "./redis";
function fixture(info: string) {
  const client = { get: vi.fn(), set: vi.fn(), del: vi.fn(), info: vi.fn(async () => info) };
  return { client, cache: new RedisCache(client, 2) };
}
describe("Redis usage sampling", () => {
  it("reads INFO once, selects the configured logical DB and never scans or reads cached payloads", async () => {
    const f = fixture(
      "redis_version:7.4\r\nused_memory:1024\r\nkeyspace_hits:3\r\nkeyspace_misses:1\r\ndb0:keys=99,expires=0\r\ndb2:keys=7,expires=2\r\n",
    );
    const result = await f.cache.readUsage();
    expect(result.metrics).toContainEqual(expect.objectContaining({ key: "keys", value: 7 }));
    expect(result.metrics).toContainEqual(
      expect.objectContaining({ key: "hit_percent", value: 75 }),
    );
    expect(f.client.info).toHaveBeenCalledTimes(1);
    expect(f.client.get).not.toHaveBeenCalled();
  });
  it("keeps absent metrics unknown, handles zero hits and rejects oversized responses", async () => {
    const result = await fixture(
      "keyspace_hits:0\nkeyspace_misses:0\nused_memory:invalid",
    ).cache.readUsage();
    expect(result.metrics).toContainEqual(
      expect.objectContaining({ key: "hit_percent", value: null }),
    );
    expect(result.metrics).toContainEqual(
      expect.objectContaining({ key: "used_memory", value: null }),
    );
    await expect(fixture("x".repeat(1024 * 1024 + 1)).cache.readUsage()).rejects.toThrow("limit");
  });
});
