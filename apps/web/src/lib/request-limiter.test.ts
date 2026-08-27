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

  it("spends the Redis-verified allowance locally before re-evaluating", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const evaluate = vi.fn().mockResolvedValue(1);
    const limiter = new RedisRequestLimiter(evaluate);

    // count=1，limit=3：本次放行且剩余 2 次本地放行额度。
    await expect(limiter.allow("runner", 3, 60_000)).resolves.toBe(true);
    await expect(limiter.allow("runner", 3, 60_000)).resolves.toBe(true);
    await expect(limiter.allow("runner", 3, 60_000)).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);

    // 余量耗尽后回源 Redis；Redis 判定超限即拒绝。
    evaluate.mockResolvedValue(4);
    await expect(limiter.allow("runner", 3, 60_000)).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("re-evaluates after the allowance memo expires", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const evaluate = vi.fn().mockResolvedValue(1);
    const limiter = new RedisRequestLimiter(evaluate);

    await expect(limiter.allow("runner", 3, 60_000)).resolves.toBe(true);
    now.mockReturnValue(3_001);
    await expect(limiter.allow("runner", 3, 60_000)).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("does not memo a rejected evaluation", async () => {
    const evaluate = vi.fn().mockResolvedValue(3);
    const limiter = new RedisRequestLimiter(evaluate);

    await expect(limiter.allow("runner", 2, 60_000)).resolves.toBe(false);
    await expect(limiter.allow("runner", 2, 60_000)).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
