import { describe, expect, it } from "vitest";

import { SessionIdentityCache } from "../src/session-identity-cache";
import type { AuthenticatedIdentity } from "@autoforge/domain";

function identity(userId: string): AuthenticatedIdentity {
  return {
    user: {
      id: userId,
      username: `user-${userId}`,
      displayName: `User ${userId}`,
      source: "local",
      status: "active",
      forcePasswordChange: false,
      failedLoginAttempts: 0,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
      version: 1,
    },
    sessionId: `session-${userId}`,
    systemPermissions: [],
    projectPermissions: {},
  };
}

describe("SessionIdentityCache", () => {
  it("returns cached identities before expiry and drops them after", () => {
    const cache = new SessionIdentityCache(1_500);
    cache.set("hash-a", identity("a"), 1_000);
    expect(cache.get("hash-a", 2_499)?.user.id).toBe("a");
    expect(cache.get("hash-a", 2_500)).toBeUndefined();
    expect(cache.get("hash-missing", 1_000)).toBeUndefined();
  });

  it("evicts the oldest entry when capacity is exhausted", () => {
    const cache = new SessionIdentityCache(1_500, 2);
    cache.set("hash-a", identity("a"), 1_000);
    cache.set("hash-b", identity("b"), 1_001);
    cache.set("hash-c", identity("c"), 1_002);
    expect(cache.get("hash-a", 1_100)).toBeUndefined();
    expect(cache.get("hash-b", 1_100)?.user.id).toBe("b");
    expect(cache.get("hash-c", 1_100)?.user.id).toBe("c");
  });

  it("refreshes ordering when an existing entry is overwritten", () => {
    const cache = new SessionIdentityCache(1_500, 2);
    cache.set("hash-a", identity("a"), 1_000);
    cache.set("hash-b", identity("b"), 1_001);
    cache.set("hash-a", identity("a2"), 1_002);
    cache.set("hash-c", identity("c"), 1_003);
    expect(cache.get("hash-a", 1_100)?.user.id).toBe("a2");
    expect(cache.get("hash-b", 1_100)).toBeUndefined();
  });

  it("clear removes every entry", () => {
    const cache = new SessionIdentityCache(1_500);
    cache.set("hash-a", identity("a"), 1_000);
    cache.clear();
    expect(cache.get("hash-a", 1_100)).toBeUndefined();
  });
});
