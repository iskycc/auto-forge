import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, opendir, rename, rm, statfs, utimes, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";

const retentionMs = 24 * 60 * 60 * 1_000;
const maximumBytes = 32 * 1_024 ** 3;
const maximumEntries = 10_000;
const maximumPending = 64;
const maximumDownloads = 2;
const downloadTimeoutMs = 10 * 60 * 1_000;

type Archive = { url: string; sha256: string; sizeBytes: number };
type CacheEntry = { sizeBytes: number; lastUsedAt: number };

/** Rebuildable node-local cache, shared by Lite and Full. No database writes or
 * external credentials are needed to serve a previously validated archive. */
export class RuntimeArchiveCache {
  private readonly root: string;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly readers = new Map<string, number>();
  private readonly waiters: Array<() => void> = [];
  private initialization: Promise<void> | undefined;
  private activeDownloads = 0;
  private usedBytes = 0;

  constructor(
    private readonly dependencies: {
      dataDirectory: string;
      now: () => number;
      fetch: typeof fetch;
    },
  ) {
    this.root = join(dependencies.dataDirectory, "cache", "runtime-archives", "v1");
  }

  async open(archive: Archive, signal: AbortSignal) {
    signal.throwIfAborted();
    validateArchive(archive);
    await (this.initialization ??= this.initialize().catch((error: unknown) => {
      this.initialization = undefined;
      this.entries.clear();
      this.usedBytes = 0;
      throw error;
    }));
    const key = `${archive.sha256}-${archive.sizeBytes}`;
    this.readers.set(key, (this.readers.get(key) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = this.readers.get(key)! - 1;
      if (remaining === 0) this.readers.delete(key);
      else this.readers.set(key, remaining);
    };
    try {
      let pending = this.pending.get(key);
      if (!pending) {
        if (this.pending.size >= maximumPending) {
          throw new Error("Runtime archive cache is busy; retry after current downloads finish.");
        }
        pending = this.prepare(key, archive).finally(() => this.pending.delete(key));
        this.pending.set(key, pending);
      }
      // Cancellation stops this HTTP waiter, not a download shared by other Agents.
      const path = await abortable(pending, signal);
      signal.throwIfAborted();
      const file = await open(path, "r");
      const content = file.createReadStream({ signal });
      content.once("close", release);
      // An abort may arrive before the HTTP adapter attaches its reader. The
      // stream still exposes the error to iteration without an unhandled event.
      content.once("error", release);
      return { sizeBytes: archive.sizeBytes, content };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await opendir(this.root);
    for await (const entry of directory) {
      const path = join(this.root, entry.name);
      if (!entry.isFile() || !/^[a-f0-9]{64}-[1-9][0-9]*$/u.test(entry.name)) {
        // Private cache namespace: incomplete downloads are never reusable.
        await rm(path, { recursive: true, force: true });
        continue;
      }
      const metadata = await lstat(path);
      this.entries.set(entry.name, { sizeBytes: metadata.size, lastUsedAt: metadata.mtimeMs });
      this.usedBytes += metadata.size;
    }
    await this.prune();
  }

  private async prepare(key: string, archive: Archive): Promise<string> {
    await this.acquireDownload();
    try {
      const path = join(this.root, key);
      const entry = this.entries.get(key);
      if (
        entry &&
        this.dependencies.now() < entry.lastUsedAt + retentionMs &&
        (await matches(path, archive))
      ) {
        await this.touch(key, path);
        return path;
      }
      if (entry) await this.remove(key);
      await this.prune(archive.sizeBytes);
      const disk = await statfs(this.root);
      if (archive.sizeBytes > disk.bavail * disk.bsize) {
        throw new Error("Insufficient platform disk space for runtime archive.");
      }
      // The cache target is not an archive size limit. A larger, valid archive
      // can occupy the cache alone; concurrent reservations still count.
      if (
        archive.sizeBytes > Math.max(maximumBytes, archive.sizeBytes) - this.usedBytes ||
        this.entries.size >= maximumEntries
      ) {
        throw new Error("Runtime archive cache is busy; retry after current downloads finish.");
      }
      // Reserve before awaiting I/O, including concurrent downloads in the limit.
      this.usedBytes += archive.sizeBytes;
      try {
        await this.download(path, archive);
        this.entries.set(key, {
          sizeBytes: archive.sizeBytes,
          lastUsedAt: this.dependencies.now(),
        });
        await this.touch(key, path);
      } catch (error) {
        this.entries.delete(key);
        this.usedBytes -= archive.sizeBytes;
        await rm(path, { force: true });
        throw error;
      }
      return path;
    } finally {
      this.releaseDownload();
    }
  }

  private async download(path: string, archive: Archive) {
    const signal = AbortSignal.timeout(downloadTimeoutMs);
    const response = await this.dependencies.fetch(archive.url, {
      signal,
      redirect: "error",
      cache: "no-store",
      headers: { "Accept-Encoding": "identity", "User-Agent": "AutoForge-Control-Plane" },
    });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) > archive.sizeBytes
    ) {
      await response.body?.cancel();
      throw new Error(`Runtime archive source returned an invalid response (${response.status}).`);
    }
    const temporary = `${path}.partial`;
    const file = await open(temporary, "wx", 0o600).catch(async (error: unknown) => {
      await response.body!.cancel();
      throw error;
    });
    try {
      const digest = createHash("sha256");
      let receivedBytes = 0;
      // DOM and Node fetch declarations differ on async iteration; bridge at
      // the infrastructure boundary while keeping cancellation/backpressure.
      const content = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      for await (const chunk of content) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > archive.sizeBytes)
          throw new Error("Runtime archive exceeds declared size.");
        digest.update(chunk);
        // FileHandle.writeFile handles short writes while keeping one chunk in memory.
        await file.writeFile(chunk);
      }
      if (receivedBytes !== archive.sizeBytes || digest.digest("hex") !== archive.sha256) {
        throw new Error("Runtime archive size or SHA-256 does not match its configuration.");
      }
      await file.sync();
      await file.close();
      await rename(temporary, path);
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
  }

  private async touch(key: string, path: string) {
    const now = this.dependencies.now();
    await utimes(path, new Date(now), new Date(now));
    this.entries.get(key)!.lastUsedAt = now;
  }

  private async prune(requiredBytes = 0) {
    const now = this.dependencies.now();
    for (const [key, entry] of this.entries) {
      if (!this.pending.has(key) && !this.readers.has(key) && now >= entry.lastUsedAt + retentionMs)
        await this.remove(key);
    }
    if (requiredBytes === 0) return;
    const target = Math.max(maximumBytes, requiredBytes);
    const oldestFirst = [...this.entries].sort(
      (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
    );
    for (const [key] of oldestFirst) {
      if (this.usedBytes + requiredBytes <= target && this.entries.size < maximumEntries) break;
      if (!this.pending.has(key) && !this.readers.has(key)) await this.remove(key);
    }
  }

  private async remove(key: string) {
    await rm(join(this.root, key), { force: true });
    const entry = this.entries.get(key);
    if (entry) this.usedBytes -= entry.sizeBytes;
    this.entries.delete(key);
  }

  private async acquireDownload() {
    if (this.activeDownloads < maximumDownloads) {
      this.activeDownloads++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private releaseDownload() {
    const next = this.waiters.shift();
    if (next) next();
    else this.activeDownloads--;
  }
}

function validateArchive(archive: Archive) {
  const url = new URL(archive.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !/^[a-f0-9]{64}$/u.test(archive.sha256) ||
    !Number.isSafeInteger(archive.sizeBytes) ||
    archive.sizeBytes <= 0
  ) {
    throw new Error("Runtime archive metadata is invalid.");
  }
}

async function matches(path: string, archive: Archive) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size !== archive.sizeBytes) return false;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    return digest.digest("hex") === archive.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
