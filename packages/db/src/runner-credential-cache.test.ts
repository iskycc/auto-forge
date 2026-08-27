import { describe, expect, it, vi } from "vitest";

import type { Runner } from "@autoforge/domain";

import { RunnerCredentialLookupCache } from "./runner-credential-cache";

function makeRunner(id: string): Runner {
  return {
    id,
    name: `runner-${id}`,
    state: "online",
    os: "linux",
    architecture: "amd64",
    agentVersion: "0.2.2",
    protocolVersion: 1,
    labels: [],
    capabilities: [],
    maxConcurrency: 1,
    busySlots: 0,
    lastSeenAt: "2026-08-26T00:00:00.000Z",
    terminalEnabled: false,
    credentialVersion: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

function lookupReturning(result: { runner: Runner | null; cacheable: boolean }) {
  const lookup = vi.fn(async () => result);
  return lookup;
}

describe("RunnerCredentialLookupCache", () => {
  it("caches cacheable hits and skips the lookup while fresh", async () => {
    const cache = new RunnerCredentialLookupCache();
    const runner = makeRunner("runner-1");
    const lookup = lookupReturning({ runner, cacheable: true });

    const first = await cache.resolve(lookup, "hash-1", "2026-08-26T00:00:01.000Z");
    const second = await cache.resolve(lookup, "hash-1", "2026-08-26T00:00:02.000Z");

    expect(first).toBe(runner);
    expect(second).toBe(runner);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("never caches non-cacheable (previous-credential) hits", async () => {
    const cache = new RunnerCredentialLookupCache();
    const runner = makeRunner("runner-1");
    const lookup = lookupReturning({ runner, cacheable: false });

    await cache.resolve(lookup, "hash-old", "2026-08-26T00:00:01.000Z");
    await cache.resolve(lookup, "hash-old", "2026-08-26T00:00:01.500Z");

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("never caches misses", async () => {
    const cache = new RunnerCredentialLookupCache();
    const lookup = lookupReturning({ runner: null, cacheable: false });

    expect(await cache.resolve(lookup, "hash-none", "2026-08-26T00:00:01.000Z")).toBeNull();
    expect(await cache.resolve(lookup, "hash-none", "2026-08-26T00:00:01.500Z")).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("expires entries after the TTL", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
      const cache = new RunnerCredentialLookupCache();
      const runner = makeRunner("runner-1");
      const lookup = lookupReturning({ runner, cacheable: true });

      await cache.resolve(lookup, "hash-1", "2026-08-26T00:00:00.000Z");
      expect(await cache.resolve(lookup, "hash-1", "2026-08-26T00:00:01.000Z")).toBe(runner);
      expect(lookup).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-08-26T00:00:03.000Z"));
      await cache.resolve(lookup, "hash-1", "2026-08-26T00:00:03.000Z");
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidateRunner drops all cached hashes of that runner", async () => {
    const cache = new RunnerCredentialLookupCache();
    const runner = makeRunner("runner-1");
    const lookup = lookupReturning({ runner, cacheable: true });

    await cache.resolve(lookup, "hash-a", "2026-08-26T00:00:01.000Z");
    await cache.resolve(lookup, "hash-b", "2026-08-26T00:00:01.000Z");
    expect(cache.size).toBe(2);

    cache.invalidateRunner("runner-1");
    expect(cache.size).toBe(0);

    await cache.resolve(lookup, "hash-a", "2026-08-26T00:00:01.200Z");
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("invalidateRunner is a no-op for unknown runners", () => {
    const cache = new RunnerCredentialLookupCache();
    expect(() => cache.invalidateRunner("missing")).not.toThrow();
  });

  it("evicts the least recently used entry beyond capacity and keeps index consistent", async () => {
    const cache = new RunnerCredentialLookupCache();
    for (let index = 0; index < 1025; index += 1) {
      const runner = makeRunner(`runner-${index}`);
      await cache.resolve(
        lookupReturning({ runner, cacheable: true }),
        `hash-${index}`,
        "2026-08-26T00:00:01.000Z",
      );
    }
    expect(cache.size).toBe(1024);

    // The oldest entry was evicted: resolving it again must call the lookup.
    const evictionLookup = lookupReturning({ runner: makeRunner("runner-0"), cacheable: true });
    await cache.resolve(evictionLookup, "hash-0", "2026-08-26T00:00:01.500Z");
    expect(evictionLookup).toHaveBeenCalledTimes(1);

    // Invalidating the re-cached runner removes exactly its entry; the
    // runner-id index stays consistent for subsequent invalidations.
    cache.invalidateRunner("runner-0");
    expect(cache.size).toBe(1023);
    expect(() => cache.invalidateRunner("runner-1")).not.toThrow();
  });
});
