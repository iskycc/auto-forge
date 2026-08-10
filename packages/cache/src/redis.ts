import type { CachePort } from "@autoforge/application";

import { namespacedKey } from "./memory";

export type RedisCacheClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  del(key: string): Promise<number>;
};

export class RedisCache implements CachePort {
  constructor(private readonly client: RedisCacheClient) {}

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
