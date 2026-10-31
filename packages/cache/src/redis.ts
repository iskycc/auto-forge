import type {
  CachePort,
  InfrastructureMetric,
  InfrastructureUsageSample,
} from "@autoforge/application";

import { namespacedKey } from "./memory";

export type RedisCacheClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  del(key: string): Promise<number>;
  info?(): Promise<string>;
};

export class RedisCache implements CachePort {
  constructor(
    private readonly client: RedisCacheClient,
    private readonly databaseIndex = 0,
  ) {}

  async readUsage(): Promise<InfrastructureUsageSample> {
    if (!this.client.info) throw new Error("Redis INFO is not available for this connection.");
    const response = await this.client.info();
    if (response.length > 1024 * 1024) throw new Error("Redis INFO response exceeds its limit.");
    const fields = new Map<string, string>();
    for (const line of response.split(/\r?\n/u)) {
      const separator = line.indexOf(":");
      if (separator > 0 && !line.startsWith("#"))
        fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
    const number = (name: string) => {
      const raw = fields.get(name);
      const value = raw === undefined ? NaN : Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
    const hits = number("keyspace_hits"),
      misses = number("keyspace_misses");
    const keyspace = fields.get(`db${this.databaseIndex}`) ?? "keys=0,expires=0";
    const keys = Number(/(?:^|,)keys=(\d+)/u.exec(keyspace)?.[1] ?? 0);
    const metrics: InfrastructureMetric[] = [
      {
        key: "version",
        label: "Redis 版本",
        value: fields.get("redis_version") ?? "未提供",
        unit: "text",
      },
      { key: "database", label: "平台逻辑库", value: this.databaseIndex, unit: "count" },
      { key: "keys", label: "平台逻辑库键数", value: keys, unit: "count" },
      { key: "used_memory", label: "实例已用内存", value: number("used_memory"), unit: "bytes" },
      {
        key: "peak_memory",
        label: "实例内存峰值",
        value: number("used_memory_peak"),
        unit: "bytes",
      },
      {
        key: "max_memory",
        label: "内存上限",
        value: number("maxmemory"),
        unit: "bytes",
        detail: "0 表示 Redis 未配置 maxmemory 上限。",
      },
      { key: "clients", label: "已连接客户端", value: number("connected_clients"), unit: "count" },
      {
        key: "blocked_clients",
        label: "阻塞客户端",
        value: number("blocked_clients"),
        unit: "count",
      },
      {
        key: "operations",
        label: "当前每秒命令数",
        value: number("instantaneous_ops_per_sec"),
        unit: "count",
      },
      {
        key: "commands",
        label: "累计命令数",
        value: number("total_commands_processed"),
        unit: "count",
      },
      { key: "hits", label: "累计键命中", value: hits, unit: "count" },
      { key: "misses", label: "累计键未命中", value: misses, unit: "count" },
      {
        key: "hit_percent",
        label: "实例键命中率",
        value:
          hits !== null && misses !== null && hits + misses > 0
            ? (hits / (hits + misses)) * 100
            : null,
        unit: "percent",
      },
      { key: "evictions", label: "累计淘汰键数", value: number("evicted_keys"), unit: "count" },
      { key: "expired", label: "累计过期键数", value: number("expired_keys"), unit: "count" },
      { key: "uptime", label: "运行时长", value: number("uptime_in_seconds"), unit: "seconds" },
    ];
    return {
      metrics,
      notes: [
        "内存、命中及命令统计属于整个 Redis 实例；键数量属于平台配置的逻辑库。读取 INFO，不扫描键或读取缓存内容。",
        "平台使用 Redis 分发实时日志、短期回放和共享请求限流；执行状态与日志确认水位仍以数据库为准。",
      ],
    };
  }

  get(namespace: string, tenantId: string, schemaVersion: number, key: string) {
    return this.client.get(namespacedKey(namespace, tenantId, schemaVersion, key));
  }

  async set(input: {
    namespace: string;
    tenantId: string;
    schemaVersion: number;
    key: string;
    value: string;
    ttlMs: number;
  }): Promise<void> {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1) throw new Error("Cache TTL is invalid.");
    await this.client.set(
      namespacedKey(input.namespace, input.tenantId, input.schemaVersion, input.key),
      input.value,
      { PX: input.ttlMs },
    );
  }

  async delete(namespace: string, tenantId: string, schemaVersion: number, key: string) {
    await this.client.del(namespacedKey(namespace, tenantId, schemaVersion, key));
  }

  async close(): Promise<void> {}
}
