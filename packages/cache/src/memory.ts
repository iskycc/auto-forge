import type { CachePort } from "@autoforge/application";

type Entry = { value: string; expiresAt: number };

export class MemoryCache implements CachePort {
  private readonly entries = new Map<string, Entry>();

  async get(namespace: string, tenantId: string, schemaVersion: number, key: string) {
    const cacheKey = namespacedKey(namespace, tenantId, schemaVersion, key);
    const entry = this.entries.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(cacheKey);
      return null;
    }
    return entry.value;
  }

  async set(input: {
    namespace: string;
    tenantId: string;
    schemaVersion: number;
    key: string;
    value: string;
    ttlMs: number;
  }): Promise<void> {
    validateTtl(input.ttlMs);
    this.entries.set(
      namespacedKey(input.namespace, input.tenantId, input.schemaVersion, input.key),
      { value: input.value, expiresAt: Date.now() + input.ttlMs },
    );
  }

  async delete(namespace: string, tenantId: string, schemaVersion: number, key: string) {
    this.entries.delete(namespacedKey(namespace, tenantId, schemaVersion, key));
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

export function namespacedKey(
  namespace: string,
  tenantId: string,
  schemaVersion: number,
  key: string,
): string {
  if (!namespace || !tenantId || !key || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error("Cache key components are invalid.");
  }
  return `autoforge:${namespace}:tenant:${tenantId}:v${schemaVersion}:${key}`;
}

function validateTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 30 * 24 * 60 * 60 * 1_000) {
    throw new Error("Cache TTL is invalid.");
  }
}
