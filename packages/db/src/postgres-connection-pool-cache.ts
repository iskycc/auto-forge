import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { DomainError } from "@autoforge/domain";

type Entry = { pool: Pool; users: number; lastUsed: number };
/** Bounded infrastructure cache; references protect connections used by transactions and locks. */
export class PostgresConnectionPoolCache {
  private readonly entries = new Map<string, Entry>();
  private allocation = Promise.resolve();
  private closing = false;
  constructor(
    private readonly createPool: (url: string) => Pool,
    private readonly maximumPools = 4,
  ) {}
  async withConnection<Result>(
    url: string,
    operation: (pool: Pool) => Promise<Result>,
  ): Promise<Result> {
    const entry = await this.acquire(url);
    try {
      return await operation(entry.pool);
    } finally {
      entry.users--;
      entry.lastUsed = performance.now();
    }
  }
  snapshot() {
    const entries = [...this.entries.values()];
    return {
      pools: entries.length,
      connections: entries.reduce((n, e) => n + e.pool.totalCount, 0),
      idle: entries.reduce((n, e) => n + e.pool.idleCount, 0),
      waiting: entries.reduce((n, e) => n + e.pool.waitingCount, 0),
    };
  }
  async retire(url: string): Promise<boolean> {
    return this.exclusive(async () => {
      const key = identity(url),
        entry = this.entries.get(key);
      if (!entry) return true;
      if (entry.users) return false;
      this.entries.delete(key);
      await entry.pool.end();
      return true;
    });
  }
  async close(): Promise<void> {
    const pools = await this.exclusive(async () => {
      this.closing = true;
      const pools = [...this.entries.values()].map((entry) => entry.pool);
      this.entries.clear();
      return pools;
    });
    // End outside admission: in-flight operations may still need to observe closing.
    await Promise.all(pools.map((pool) => pool.end()));
  }
  private acquire(url: string): Promise<Entry> {
    return this.exclusive(async () => {
      if (this.closing)
        throw new DomainError("PLATFORM_LOG_BUSY", "日志连接池正在关闭，请稍后重试。");
      const key = identity(url);
      const existing = this.entries.get(key);
      if (existing) {
        existing.users++;
        return existing;
      }
      if (this.entries.size >= this.maximumPools) {
        const idle = [...this.entries]
          .filter(([, value]) => !value.users)
          .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new DomainError("PLATFORM_LOG_BUSY", "日志管理连接池繁忙，请稍后重试。");
        this.entries.delete(idle[0]);
        await idle[1].pool.end();
      }
      const entry = { pool: this.createPool(url), users: 1, lastUsed: performance.now() };
      this.entries.set(key, entry);
      return entry;
    });
  }
  private async exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.allocation;
    let release!: () => void;
    this.allocation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
function identity(url: string) {
  return createHash("sha256").update(url).digest("hex");
}
