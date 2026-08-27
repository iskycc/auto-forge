import type { Runner } from "@autoforge/domain";

/**
 * 执行机凭据查找的短 TTL 进程内缓存。每个 Runner 控制面请求（完成上报、日志、
 * 领取、续租）都按凭据散列查找执行机；高并发下该查找的串行往返显著占用请求
 * 延迟。缓存只缩短读取路径，权威事实（轮换、撤销、禁用）仍在数据库。
 *
 * 正确性边界：
 * - 只缓存“当前凭据”命中的正结果。当前凭据命中与查找时间无关；历史凭据命中
 *   依赖查找时间是否落在宽限期内，必须逐次查询数据库。不缓存空结果，避免
 *   注册/轮换后的新凭据被陈旧否定结果阻塞。
 * - 同一进程内的注册、轮换、撤销、禁用、注销、清除和心跳会立即丢弃该执行机
 *   的缓存条目，因此同实例变更不需要等待 TTL。
 * - 跨实例（Full 模式多个 Web 副本）变更的失效延迟以 TTL 为上限：其他实例上
 *   被撤销/禁用/注销的执行机在 TTL 窗口内仍可能通过认证。轮换宽限期远大于
 *   TTL，这是与吞吐折衷后明确接受的边界。
 */
const CREDENTIAL_LOOKUP_TTL_MS = 2_000;
const MAXIMUM_CACHED_LOOKUPS = 1_024;

/** 查找结果。cacheable 为 true 且命中执行机时才允许写入缓存。 */
export interface CredentialLookupOutcome {
  runner: Runner | null;
  cacheable: boolean;
}

type CacheEntry = {
  runner: Runner;
  expiresAtMs: number;
};

export class RunnerCredentialLookupCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly hashesByRunnerId = new Map<string, Set<string>>();

  async resolve(
    lookup: (credentialHash: string, now: string) => Promise<CredentialLookupOutcome>,
    credentialHash: string,
    now: string,
  ): Promise<Runner | null> {
    const cached = this.read(credentialHash);
    if (cached) return cached;
    const { runner, cacheable } = await lookup(credentialHash, now);
    if (cacheable && runner) this.store(credentialHash, runner);
    return runner;
  }

  /**
   * 执行机的凭据或生命周期状态变更后立即丢弃其全部缓存条目，使轮换、撤销、
   * 禁用、注销等控制面操作在本实例内即时生效。未命中时为空操作。
   */
  invalidateRunner(runnerId: string): void {
    const hashes = this.hashesByRunnerId.get(runnerId);
    this.hashesByRunnerId.delete(runnerId);
    if (!hashes) return;
    for (const hash of hashes) this.entries.delete(hash);
  }

  get size(): number {
    return this.entries.size;
  }

  private read(credentialHash: string): Runner | null {
    const cached = this.entries.get(credentialHash);
    if (!cached) return null;
    if (cached.expiresAtMs <= Date.now()) {
      this.evictHash(credentialHash);
      return null;
    }
    // LRU：命中后移到队尾，驱逐时总是淘汰最久未用的条目。
    this.entries.delete(credentialHash);
    this.entries.set(credentialHash, cached);
    return cached.runner;
  }

  private store(credentialHash: string, runner: Runner): void {
    this.entries.delete(credentialHash);
    this.entries.set(credentialHash, {
      runner,
      expiresAtMs: Date.now() + CREDENTIAL_LOOKUP_TTL_MS,
    });
    let hashes = this.hashesByRunnerId.get(runner.id);
    if (!hashes) {
      hashes = new Set();
      this.hashesByRunnerId.set(runner.id, hashes);
    }
    hashes.add(credentialHash);
    if (this.entries.size > MAXIMUM_CACHED_LOOKUPS) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.evictHash(oldest);
    }
  }

  private evictHash(credentialHash: string): void {
    const entry = this.entries.get(credentialHash);
    this.entries.delete(credentialHash);
    if (!entry) return;
    const hashes = this.hashesByRunnerId.get(entry.runner.id);
    if (!hashes) return;
    hashes.delete(credentialHash);
    if (hashes.size === 0) this.hashesByRunnerId.delete(entry.runner.id);
  }
}
