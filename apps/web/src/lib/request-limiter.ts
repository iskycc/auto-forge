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

export class RedisRequestLimiter implements RequestLimiter {
  constructor(private readonly evaluate: RedisEvaluate) {}

  async allow(key: string, limit: number, windowMs: number): Promise<boolean> {
    const result = await this.evaluate(REDIS_RATE_LIMIT_SCRIPT, {
      keys: [`autoforge:rate:v1:${key}`],
      arguments: [String(windowMs)],
    });
    const count = Number(result);
    if (!Number.isSafeInteger(count))
      throw new Error("Redis returned an invalid rate-limit count.");
    return count <= limit;
  }
}
