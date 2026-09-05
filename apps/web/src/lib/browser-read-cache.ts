type CacheEntry = { value: unknown; bytes: number; storedAt: number };
const entries = new Map<string, CacheEntry>();
const MAXIMUM_BYTES = 24 * 1_024 * 1_024;
const MAXIMUM_AGE_MS = 5 * 60_000;
let bytes = 0;
let scope = "";
let epoch = 0;
export function browserCacheEpoch(): number {
  return epoch;
}

export function configureBrowserCacheScope(nextScope: string): void {
  if (scope !== nextScope) {
    clearBrowserSnapshots();
    scope = nextScope;
  }
}

/** Session-memory only: cached business data never survives logout or a browser restart. */
export function readBrowserSnapshot(key: string): unknown | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt >= MAXIMUM_AGE_MS) {
    remove(key);
    return undefined;
  }
  entries.delete(key);
  entries.set(key, entry);
  return entry.value;
}

export function writeBrowserSnapshot(key: string, value: unknown, requestedEpoch = epoch): void {
  if (requestedEpoch !== epoch) return;
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  remove(key);
  if (size > MAXIMUM_BYTES) return;
  while (bytes + size > MAXIMUM_BYTES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    remove(oldest);
  }
  entries.set(key, { value, bytes: size, storedAt: Date.now() });
  bytes += size;
}

export function clearBrowserSnapshots(): void {
  epoch += 1;
  entries.clear();
  bytes = 0;
}

function remove(key: string): void {
  const entry = entries.get(key);
  if (entry) bytes -= entry.bytes;
  entries.delete(key);
}
