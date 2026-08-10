import { describe, expect, it, vi } from "vitest";

import { MemoryCache, namespacedKey } from "../src/memory";
import { RedisCache } from "../src/redis";

describe("cache adapters", () => {
  it("expires rebuildable in-memory values", async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache();
      await cache.set({
        namespace: "runner",
        tenantId: "project-1",
        schemaVersion: 1,
        key: "summary",
        value: "cached",
        ttlMs: 1_000,
      });
      await expect(cache.get("runner", "project-1", 1, "summary")).resolves.toBe("cached");
      vi.advanceTimersByTime(1_001);
      await expect(cache.get("runner", "project-1", 1, "summary")).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses tenant and schema namespacing for Redis", async () => {
    const client = {
      get: vi.fn().mockResolvedValue("value"),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
    };
    const cache = new RedisCache(client);
    await cache.set({
      namespace: "dashboard",
      tenantId: "project-1",
      schemaVersion: 2,
      key: "summary",
      value: "value",
      ttlMs: 5_000,
    });
    expect(client.set).toHaveBeenCalledWith(
      namespacedKey("dashboard", "project-1", 2, "summary"),
      "value",
      { PX: 5_000 },
    );
  });
});
