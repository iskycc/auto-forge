const REDIS_RATE_LIMIT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return count
`;
const MAXIMUM_MEMORY_KEYS = 10_000;

export interface RequestLimiter {
  allow(key: string, limit: number, windowMs: number): Promise<boolean>;
}

type WindowCounter = {
  count: number;
  resetAt: number;
};

export class MemoryRequestLimiter implements RequestLimiter {
  private readonly counters = new Map<string, WindowCounter>();

  async allow(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const current = this.counters.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.counters.size >= MAXIMUM_MEMORY_KEYS) {
        for (const [candidateKey, counter] of this.counters) {
          if (counter.resetAt <= now) this.counters.delete(candidateKey);
        }
        if (this.counters.size >= MAXIMUM_MEMORY_KEYS) return false;
      }
      this.counters.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }
}

type RedisEvaluate = (
  script: string,
  options: { keys: string[]; arguments: string[] },
) => Promise<unknown>;

/**
 * Redis 计数核验后的本地放行余量有效期。执行机协议高频路径上每个请求都等待
 * 一次 Redis 往返会显著拉长关键路径；核验一次后按“剩余可放行次数”本地放行，
 * 余量耗尽或到期立即回源。单实例放行总量不超过 Redis 已核验的窗口配额，
 * 跨进程视角的滞后以 TTL 为上限。
 */
const REDIS_ALLOWANCE_MEMO_TTL_MS = 2_000;
const MAXIMUM_ALLOWANCE_MEMOS = 1_024;

type AllowanceMemo = {
  expiresAtMs: number;
  remaining: number;
};

export class RedisRequestLimiter implements RequestLimiter {
  private readonly allowanceMemos = new Map<string, AllowanceMemo>();

  constructor(private readonly evaluate: RedisEvaluate) {}

  async allow(key: string, limit: number, windowMs: number): Promise<boolean> {
    const memoKey = `${key}:${windowMs}:${limit}`;
    const nowMs = Date.now();
    const memo = this.allowanceMemos.get(memoKey);
    if (memo && memo.expiresAtMs > nowMs && memo.remaining > 0) {
      memo.remaining -= 1;
      return true;
    }
    const result = await this.evaluate(REDIS_RATE_LIMIT_SCRIPT, {
      keys: [`autoforge:rate:v1:${key}`],
      arguments: [String(windowMs)],
    });
    const count = Number(result);
    if (!Number.isSafeInteger(count))
      throw new Error("Redis returned an invalid rate-limit count.");
    const allowed = count <= limit;
    if (allowed) {
      if (this.allowanceMemos.size >= MAXIMUM_ALLOWANCE_MEMOS) this.allowanceMemos.clear();
      this.allowanceMemos.set(memoKey, {
        expiresAtMs: nowMs + REDIS_ALLOWANCE_MEMO_TTL_MS,
        remaining: limit - count,
      });
    } else {
      this.allowanceMemos.delete(memoKey);
    }
    return allowed;
  }
}
