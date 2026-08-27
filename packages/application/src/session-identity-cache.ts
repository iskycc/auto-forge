import type { AuthenticatedIdentity } from "@autoforge/domain";

interface SessionCacheEntry {
  identity: AuthenticatedIdentity;
  expiresAtMs: number;
}

/**
 * 会话身份短 TTL 内存缓存。鉴权读取是每次页面读取与 API 调用的固定成本，
 * 高并发风暴下单次数据库往返会被事件循环排队显著放大；短 TTL 让热点会话
 * 直接命中内存。同进程内的会话撤销与角色/用户变更通过显式失效钩子立即
 * 生效，跨进程部署或遗漏钩子的最坏情况以 TTL 为上限。
 */
export class SessionIdentityCache {
  private readonly entries = new Map<string, SessionCacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly capacity = 256,
  ) {}

  get(tokenHash: string, nowMs: number): AuthenticatedIdentity | undefined {
    const entry = this.entries.get(tokenHash);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(tokenHash);
      return undefined;
    }
    return entry.identity;
  }

  set(tokenHash: string, identity: AuthenticatedIdentity, nowMs: number): void {
    // Map 保持插入顺序；容量耗尽时驱逐最早写入的条目，写入前先删除以刷新顺序。
    if (this.entries.size >= this.capacity && !this.entries.has(tokenHash)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    } else {
      this.entries.delete(tokenHash);
    }
    this.entries.set(tokenHash, { identity, expiresAtMs: nowMs + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}
