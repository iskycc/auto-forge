import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryRequestLimiter, RedisRequestLimiter } from "./request-limiter";

afterEach(() => vi.restoreAllMocks());

describe("MemoryRequestLimiter", () => {
  it("enforces and resets a fixed request window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const limiter = new MemoryRequestLimiter();

    await expect(limiter.allow("runner", 2, 1_000)).resolves.toBe(true);
    await expect(limiter.allow("runner", 2, 1_000)).resolves.toBe(true);
    await expect(limiter.allow("runner", 2, 1_000)).resolves.toBe(false);

    vi.mocked(Date.now).mockReturnValue(2_000);
    await expect(limiter.allow("runner", 2, 1_000)).resolves.toBe(true);
  });
});

describe("RedisRequestLimiter", () => {
  it("uses a namespaced key and rejects counts over the limit", async () => {
    const evaluate = vi.fn().mockResolvedValue(3);
    const limiter = new RedisRequestLimiter(evaluate);

    await expect(limiter.allow("runner", 2, 5_000)).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledWith(expect.any(String), {
      keys: ["autoforge:rate:v1:runner"],
      arguments: ["5000"],
    });
  });
});
