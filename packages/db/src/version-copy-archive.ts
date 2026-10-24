import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { DomainError } from "@autoforge/domain";
import { versionCopyObjectReferences } from "@autoforge/application";
import type {
  JarObjectStorePort,
  ProjectVersionCopyRepository,
  VersionCopyArchivePort,
  VersionCopyCollection,
  VersionCopyManifest,
  VersionCopyRow,
  VersionCopySnapshotReader,
  VersionCopySnapshotDescriptor,
  VersionCopyState,
} from "@autoforge/application";
import { VERSION_COPY_TABLES, versionCopyRowKey } from "./version-copy-plan";
import { projectVersionCopyManifestSchema } from "@autoforge/contracts";

const MINIMUM_FREE_BYTES = 128 * 1024 * 1024;
const PAGE_BYTES = 2 * 1024 * 1024;

/** Private disk snapshots close the source DB read transaction before any object-store network I/O. */
export class VersionCopyArchive implements VersionCopyArchivePort {
  constructor(
    private readonly repository: ProjectVersionCopyRepository,
    private readonly objects: JarObjectStorePort,
    private readonly dataDirectory: string,
  ) {}
  private async temporaryDirectory(): Promise<string> {
    const root = join(this.dataDirectory, "tmp", "version-copies");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await requireSpace(root, MINIMUM_FREE_BYTES);
    return mkdtemp(join(root, "snapshot-"));
  }
  async ensureObjectCapacity(sizeBytes: number): Promise<void> {
    const directory =
      this.objects.storageKind === "local"
        ? join(this.dataDirectory, "objects")
        : this.dataDirectory;
    await requireSpace(
      directory,
      MINIMUM_FREE_BYTES + (this.objects.storageKind === "local" ? sizeBytes : 0),
    );
  }
  async capture(
    job: VersionCopyState,
    signal: AbortSignal,
  ): ReturnType<VersionCopyArchivePort["capture"]> {
    const directory = await this.temporaryDirectory();
    const path = join(directory, "snapshot.sqlite");
    let writer: SnapshotWriter | undefined;
    try {
      writer = new SnapshotWriter(path);
      await chmod(path, 0o600);
      await this.repository.capture(
        job,
        {
          append: async (collection, rows) => {
            signal.throwIfAborted();
            await requireSpace(
              directory,
              MINIMUM_FREE_BYTES +
                rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0),
            );
            writer!.append(collection, rows);
          },
        },
        signal,
      );
      const manifest = writer.finish();
      writer.close();
      writer = undefined;
      const sizeBytes = (await stat(path)).size;
      const sha256 = await digestFile(path, signal);
      const objectKey = `projects/${job.targetProjectId}/version-copies/${job.id}/snapshot.sqlite`;
      await this.ensureObjectCapacity(sizeBytes);
      await this.objects.putObject({
        objectKey,
        sha256,
        sizeBytes,
        mediaType: "application/vnd.sqlite3",
        content: fileChunks(path, signal),
      });
      return { descriptor: { objectKey, sha256, sizeBytes }, manifest };
    } finally {
      writer?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  async open(
    descriptor: VersionCopySnapshotDescriptor,
    signal: AbortSignal,
  ): Promise<VersionCopySnapshotReader> {
    const directory = await this.temporaryDirectory();
    const path = join(directory, "snapshot.sqlite");
    try {
      await requireSpace(directory, MINIMUM_FREE_BYTES + descriptor.sizeBytes);
      const source = await this.objects.openRead(descriptor.objectKey);
      if (source.sizeBytes !== descriptor.sizeBytes) {
        if (source.content instanceof Readable) source.content.destroy();
        else await source.content[Symbol.asyncIterator]().return?.();
        throw new DomainError("VERSION_COPY_SNAPSHOT_CORRUPT", "版本复制快照大小不一致。");
      }
      const file = await open(path, "wx", 0o600);
      try {
        let bytes = 0;
        const hash = createHash("sha256");
        const destination = new Writable({
          write(chunk: Buffer, _encoding, done) {
            bytes += chunk.byteLength;
            hash.update(chunk);
            if (bytes > descriptor.sizeBytes) {
              done(new Error("复制快照超过声明大小。"));
              return;
            }
            void file.writeFile(chunk).then(
              () => done(),
              (cause: unknown) =>
                done(cause instanceof Error ? cause : new Error("写入复制快照失败。", { cause })),
            );
          },
        });
        await pipeline(Readable.from(source.content), destination, { signal });
        if (bytes !== descriptor.sizeBytes || hash.digest("hex") !== descriptor.sha256)
          throw new DomainError("VERSION_COPY_SNAPSHOT_CORRUPT", "版本复制快照校验失败。");
      } finally {
        await file.close();
      }
      return new SnapshotReader(path, async () => rm(directory, { recursive: true, force: true }));
    } catch (cause) {
      await rm(directory, { recursive: true, force: true });
      throw cause;
    }
  }
}

class SnapshotWriter {
  private readonly database: Database.Database;
  private readonly counts = new Map(VERSION_COPY_TABLES.map((table) => [table.name, 0]));
  private objectCount = 0;
  constructor(path: string) {
    this.database = new Database(path);
    this.database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE records(collection TEXT NOT NULL,ordinal INTEGER NOT NULL,record_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(collection,ordinal),UNIQUE(collection,record_key));
      CREATE TABLE objects(ordinal INTEGER PRIMARY KEY,object_key TEXT NOT NULL UNIQUE,sha256 TEXT,size_bytes INTEGER);
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  append(collection: VersionCopyCollection, rows: readonly VersionCopyRow[]): void {
    const insert = this.database.prepare(
      "INSERT INTO records(collection,ordinal,record_key,payload) VALUES (?,?,?,?)",
    );
    const insertObject = this.database.prepare(
      "INSERT INTO objects(ordinal,object_key,sha256,size_bytes) VALUES (?,?,?,?) ON CONFLICT(object_key) DO UPDATE SET sha256=COALESCE(objects.sha256,excluded.sha256),size_bytes=COALESCE(objects.size_bytes,excluded.size_bytes)",
    );
    const existingObject = this.database.prepare(
      "SELECT ordinal,sha256,size_bytes FROM objects WHERE object_key=?",
    );
    this.database.transaction(() => {
      let count = this.counts.get(collection.name) ?? 0;
      for (const row of rows) {
        try {
          insert.run(
            collection.name,
            count++,
            versionCopyRowKey(collection, row),
            JSON.stringify(row),
          );
        } catch (cause) {
          throw new DomainError(
            "VERSION_COPY_SNAPSHOT_INVALID",
            `生成 ${collection.name} 快照失败，记录标识重复或不可读。`,
            { cause },
          );
        }
        for (const reference of versionCopyObjectReferences(collection.name, row)) {
          const previous = existingObject.get(reference.objectKey) as
            { ordinal: number; sha256: string | null; size_bytes: number | null } | undefined;
          if (
            previous &&
            ((previous.sha256 && reference.sha256 && previous.sha256 !== reference.sha256) ||
              (previous.size_bytes !== null &&
                reference.sizeBytes !== undefined &&
                previous.size_bytes !== reference.sizeBytes))
          )
            throw new DomainError(
              "VERSION_COPY_OBJECT_CORRUPT",
              "源文件被多条记录引用，但校验值不一致。",
            );
          insertObject.run(
            this.objectCount,
            reference.objectKey,
            reference.sha256 ?? null,
            reference.sizeBytes ?? null,
          );
          if (!previous) this.objectCount++;
        }
      }
      this.counts.set(collection.name, count);
    })();
  }
  finish(): VersionCopyManifest {
    const collections = VERSION_COPY_TABLES.map((table) => ({
      name: table.name,
      primaryKey: [...table.primaryKey],
      count: this.counts.get(table.name) ?? 0,
    }));
    const manifest: VersionCopyManifest = {
      schemaVersion: 1,
      collections,
      rows: collections.reduce((total, table) => total + table.count, 0),
      objects: this.objectCount,
      attempts: this.counts.get("run_attempts") ?? 0,
    };
    this.database
      .prepare("INSERT INTO metadata(key,value) VALUES ('manifest',?)")
      .run(JSON.stringify(manifest));
    return manifest;
  }
  close(): void {
    this.database.close();
  }
}

class SnapshotReader implements VersionCopySnapshotReader {
  private readonly database: Database.Database;
  readonly manifest: VersionCopyManifest;
  constructor(
    path: string,
    private readonly remove: () => Promise<void>,
  ) {
    this.database = new Database(path, { readonly: true, fileMustExist: true });
    this.database.pragma("query_only=ON");
    const row = this.database.prepare("SELECT value FROM metadata WHERE key='manifest'").get() as
      { value: string } | undefined;
    if (!row) {
      this.database.close();
      throw new Error("复制快照缺少清单。");
    }
    try {
      this.manifest = projectVersionCopyManifestSchema.parse(JSON.parse(row.value));
    } catch (cause) {
      this.database.close();
      throw new DomainError("VERSION_COPY_SNAPSHOT_CORRUPT", "复制快照清单校验失败。", { cause });
    }
    if (
      this.manifest.schemaVersion !== 1 ||
      this.manifest.collections.length !== VERSION_COPY_TABLES.length ||
      this.manifest.collections.some(
        (table, index) =>
          table.name !== VERSION_COPY_TABLES[index]!.name ||
          JSON.stringify(table.primaryKey) !==
            JSON.stringify(VERSION_COPY_TABLES[index]!.primaryKey),
      )
    ) {
      this.database.close();
      throw new Error("复制快照格式不兼容。");
    }
  }
  async records(collection: string, after: number, limit: number) {
    if (!VERSION_COPY_TABLES.some((table) => table.name === collection))
      throw new Error("未知复制集合。");
    const keys = this.database
      .prepare(
        "SELECT ordinal,length(payload)*4 AS bytes FROM records WHERE collection=? AND ordinal>? ORDER BY ordinal LIMIT ?",
      )
      .all(collection, after, Math.min(32, limit)) as Array<{ ordinal: number; bytes: number }>;
    let bytes = 0;
    const selected: number[] = [];
    for (const key of keys) {
      if (selected.length && bytes + key.bytes > PAGE_BYTES) break;
      selected.push(key.ordinal);
      bytes += key.bytes;
    }
    if (!selected.length) return [];
    const rows = this.database
      .prepare(
        `SELECT ordinal,record_key,payload FROM records WHERE collection=? AND ordinal IN (${selected.map(() => "?").join(",")}) ORDER BY ordinal`,
      )
      .all(collection, ...selected) as Array<{
      ordinal: number;
      record_key: string;
      payload: string;
    }>;
    return rows.map((row) => ({
      collection,
      ordinal: row.ordinal,
      key: row.record_key,
      row: JSON.parse(row.payload) as VersionCopyRow,
    }));
  }
  async objects(after: number, limit: number) {
    const rows = this.database
      .prepare(
        "SELECT ordinal,object_key AS objectKey,sha256,size_bytes AS sizeBytes FROM objects WHERE ordinal>? ORDER BY ordinal LIMIT ?",
      )
      .all(after, Math.min(32, limit)) as Array<{
      ordinal: number;
      objectKey: string;
      sha256: string | null;
      sizeBytes: number | null;
    }>;
    return rows.map(({ sha256, sizeBytes, ...object }) => ({
      ...object,
      ...(sha256 ? { sha256 } : {}),
      ...(sizeBytes !== null ? { sizeBytes } : {}),
    }));
  }
  async find(collection: string, key: string): Promise<VersionCopyRow | null> {
    const row = this.database
      .prepare("SELECT payload FROM records WHERE collection=? AND record_key=?")
      .get(collection, key) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as VersionCopyRow) : null;
  }
  async close(): Promise<void> {
    this.database.close();
    await this.remove();
  }
}

async function requireSpace(directory: string, bytes: number): Promise<void> {
  const filesystem = await statfs(directory);
  if (filesystem.bavail * filesystem.bsize < bytes)
    throw new DomainError(
      "VERSION_COPY_DISK_FULL",
      "复制所需磁盘余量不足，已暂停复制，请释放空间后重试。",
    );
}
async function* fileChunks(path: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(path, { highWaterMark: 256 * 1024, signal });
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      yield chunk as Buffer;
    }
  } finally {
    stream.destroy();
  }
}
async function digestFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fileChunks(path, signal)) hash.update(chunk);
  return hash.digest("hex");
}
