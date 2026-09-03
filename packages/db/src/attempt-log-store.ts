import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { constants as zlibConstants, gunzip, gzip } from "node:zlib";

import Database from "better-sqlite3";
import { DomainError } from "@autoforge/domain";

// 用例日志从主数据库剥离后，每个执行批次使用一个独立 SQLite 文件。
// 这些文件是日志内容的唯一权威来源；批次删除或保留策略触发时整个文件被移除。
const BATCH_ID_PATTERN = /^[0-9a-f-]{8,64}$/;
const MAX_OPEN_STORES = 16;
// 目录字节统计的枚举上限；批次数量由保留策略控制，该上限只防御异常目录。
const MAX_STAT_ENTRIES = 10_000;
const MINIMUM_COMPRESSION_BYTES = 1_024;
const MINIMUM_COMPRESSION_SAVING_BYTES = 64;
const LOG_READ_BATCH_ROWS = 32;
const LOG_DECOMPRESSION_CONCURRENCY = 8;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type AttemptLogStream = "stdout" | "stderr" | "agent";

export type AttemptLogChunkInput = {
  stream: AttemptLogStream;
  sequence: number;
  content: string;
  recordedAt: string;
};

export type AttemptLogItem = {
  stream: AttemptLogStream;
  sequence: number;
  content: string;
  recordedAt: string;
};

export type AttemptLogStore = {
  appendChunks(input: {
    batchId: string;
    attemptId: string;
    receivedAt: string;
    chunks: AttemptLogChunkInput[];
  }): Promise<{ stdout: number; stderr: number; agent: number }>;
  listChunks(input: {
    batchId: string;
    attemptId: string;
    stream: AttemptLogStream;
    afterSequence: number;
    limit: number;
    query?: string;
    recordedAfter?: string;
    recordedBefore?: string;
  }): Promise<{ items: AttemptLogItem[]; hasMore: boolean }>;
  acknowledgedSequence(batchId: string, attemptId: string, stream: AttemptLogStream): number;
  // Agent 完成上报会携带自己的确认水位；写入批次文件保证重传基准与块水位同源。
  recordWatermarks(input: {
    batchId: string;
    attemptId: string;
    watermarks: { stdout: number; stderr: number; agent: number };
    recordedAt: string;
  }): void;
  removeBatchStore(batchId: string): void;
  batchStoreStats(batchIds: readonly string[]): Map<string, number>;
  directoryBytes(): number;
  // 批次存储文件相对数据目录的路径；主库 attempt_logs_path 只记录该相对路径。
  relativeStorePath(batchId: string): string;
  close(): void;
};

export function createAttemptLogStore(attemptLogsDirectory: string): AttemptLogStore {
  mkdirSync(attemptLogsDirectory, { recursive: true });
  const openStores = new Map<string, BatchStoreHandle>();

  function prepared(handle: BatchStoreHandle, sql: string): Database.Statement {
    const cached = handle.statements.get(sql);
    if (cached) return cached;
    const statement = handle.client.prepare(sql);
    handle.statements.set(sql, statement);
    return statement;
  }

  function openBatch(batchId: string): BatchStoreHandle {
    const cached = openStores.get(batchId);
    if (cached) {
      // LRU：命中后移到队尾，驱逐时总是关闭最久未用的句柄。
      openStores.delete(batchId);
      openStores.set(batchId, cached);
      return cached;
    }
    if (openStores.size >= MAX_OPEN_STORES) {
      const oldest = openStores.keys().next().value as string | undefined;
      if (oldest) closeStore(oldest);
    }
    const client = new Database(storePath(attemptLogsDirectory, batchId));
    client.pragma("journal_mode = WAL");
    // 与主库一致的 WAL 持久化折衷：NORMAL 在操作系统崩溃时最多丢失最后一段
    // 已提交日志，不会损坏库文件。日志写入位于 Web 事件循环上的同步调用，
    // FULL 模式的每次提交 fsync 会阻塞全部请求处理，高并发基准中代价显著。
    client.pragma("synchronous = NORMAL");
    client.pragma("foreign_keys = OFF");
    client.pragma("busy_timeout = 5000");
    client.exec(`
      CREATE TABLE IF NOT EXISTS attempt_log_chunks (
        attempt_id TEXT NOT NULL,
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'agent')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        content BLOB NOT NULL,
        content_encoding TEXT NOT NULL DEFAULT 'identity'
          CHECK (content_encoding IN ('identity', 'gzip')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        stored_size_bytes INTEGER,
        content_sha256 TEXT,
        recorded_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, stream, sequence)
      );
      CREATE INDEX IF NOT EXISTS attempt_log_chunks_read_idx
        ON attempt_log_chunks (attempt_id, stream, sequence);
      CREATE TABLE IF NOT EXISTS attempt_log_watermarks (
        attempt_id TEXT NOT NULL,
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'agent')),
        acknowledged_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, stream)
      );
    `);
    ensureCompressionColumns(client);
    const handle: BatchStoreHandle = { client, statements: new Map() };
    openStores.set(batchId, handle);
    return handle;
  }

  function closeStore(batchId: string): void {
    const handle = openStores.get(batchId);
    if (!handle) return;
    openStores.delete(batchId);
    handle.client.pragma("wal_checkpoint(TRUNCATE)");
    handle.client.close();
  }

  function advanceWatermark(
    handle: BatchStoreHandle,
    attemptId: string,
    stream: AttemptLogStream,
    updatedAt: string,
  ): number {
    // 水位推进语义与迁移前的主库实现一致：从当前水位起只承认严格连续的序号。
    const existing = prepared(
      handle,
      "SELECT acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id = ? AND stream = ?",
    ).get(attemptId, stream) as { acknowledged_sequence: number } | undefined;
    let acknowledged = existing?.acknowledged_sequence ?? -1;
    const sequences = prepared(
      handle,
      `SELECT sequence FROM attempt_log_chunks
       WHERE attempt_id = ? AND stream = ? AND sequence > ? ORDER BY sequence`,
    ).all(attemptId, stream, acknowledged) as Array<{ sequence: number }>;
    for (const row of sequences) {
      if (row.sequence !== acknowledged + 1) break;
      acknowledged = row.sequence;
    }
    prepared(
      handle,
      `INSERT INTO attempt_log_watermarks (attempt_id, stream, acknowledged_sequence, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(attempt_id, stream) DO UPDATE SET
       acknowledged_sequence = MAX(attempt_log_watermarks.acknowledged_sequence, excluded.acknowledged_sequence),
       updated_at = excluded.updated_at`,
    ).run(attemptId, stream, acknowledged, updatedAt);
    return acknowledged;
  }

  function readStoredRows(
    handle: BatchStoreHandle,
    input: {
      attemptId: string;
      stream: AttemptLogStream;
      afterSequence: number;
      recordedAfter?: string;
      recordedBefore?: string;
    },
    limit: number,
  ): StoredLogRow[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [input.attemptId, input.stream, input.afterSequence];
    if (input.recordedAfter) {
      clauses.push("recorded_at >= ?");
      parameters.push(input.recordedAfter);
    }
    if (input.recordedBefore) {
      clauses.push("recorded_at <= ?");
      parameters.push(input.recordedBefore);
    }
    parameters.push(limit);
    const filters = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";
    return prepared(
      handle,
      `SELECT stream, sequence, content, content_encoding, size_bytes, recorded_at
       FROM attempt_log_chunks
       WHERE attempt_id = ? AND stream = ? AND sequence > ? ${filters}
       ORDER BY sequence ASC LIMIT ?`,
    ).all(...parameters) as StoredLogRow[];
  }

  return {
    async appendChunks(input) {
      assertBatchId(input.batchId);
      const encodedChunks = await Promise.all(input.chunks.map(encodeLogChunk));
      // 压缩在取得 SQLite 句柄前完成；异步 zlib 运行期间 LRU 可能驱逐旧句柄，
      // 因此不能跨 await 持有可能已被关闭的数据库连接。
      const handle = openBatch(input.batchId);
      return handle.client
        .transaction(() => {
          for (const chunk of encodedChunks) {
            const existing = prepared(
              handle,
              `SELECT content, content_encoding, size_bytes, content_sha256, recorded_at
               FROM attempt_log_chunks
             WHERE attempt_id = ? AND stream = ? AND sequence = ?`,
            ).get(input.attemptId, chunk.stream, chunk.sequence) as
              | {
                  content: string | Buffer;
                  content_encoding: StoredContentEncoding;
                  size_bytes: number;
                  content_sha256: string | null;
                  recorded_at: string;
                }
              | undefined;
            if (existing) {
              const sameContent = existing.content_sha256
                ? existing.size_bytes === chunk.sizeBytes &&
                  existing.content_sha256 === chunk.contentSha256
                : legacyContentEquals(existing.content, chunk.plainContent);
              if (!sameContent || existing.recorded_at !== chunk.recordedAt) {
                throw new DomainError("LOG_CHUNK_CONFLICT", "相同日志序号已保存不同内容。");
              }
              continue;
            }
            prepared(
              handle,
              `INSERT INTO attempt_log_chunks
             (attempt_id, stream, sequence, content, content_encoding, size_bytes,
              stored_size_bytes, content_sha256, recorded_at, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              input.attemptId,
              chunk.stream,
              chunk.sequence,
              chunk.storedContent,
              chunk.contentEncoding,
              chunk.sizeBytes,
              chunk.storedSizeBytes,
              chunk.contentSha256,
              chunk.recordedAt,
              input.receivedAt,
            );
          }
          return {
            stdout: advanceWatermark(handle, input.attemptId, "stdout", input.receivedAt),
            stderr: advanceWatermark(handle, input.attemptId, "stderr", input.receivedAt),
            agent: advanceWatermark(handle, input.attemptId, "agent", input.receivedAt),
          };
        })
        .immediate();
    },

    async listChunks(input) {
      assertBatchId(input.batchId);
      const handle = openBatch(input.batchId);
      const items: AttemptLogItem[] = [];
      let afterSequence = input.afterSequence;
      let exhausted = false;
      while (items.length <= input.limit && !exhausted) {
        const rows = readStoredRows(
          handle,
          {
            ...input,
            afterSequence,
          },
          input.query ? LOG_READ_BATCH_ROWS : input.limit + 1,
        );
        exhausted = rows.length < (input.query ? LOG_READ_BATCH_ROWS : input.limit + 1);
        if (rows.length === 0) break;
        afterSequence = rows.at(-1)?.sequence ?? afterSequence;
        const decoded = await decodeStoredRows(rows);
        for (const item of decoded) {
          if (!input.query || item.content.includes(input.query)) items.push(item);
          if (items.length > input.limit) break;
        }
        if (!input.query) break;
      }
      return {
        items: items.slice(0, input.limit),
        hasMore: items.length > input.limit,
      };
    },

    acknowledgedSequence(batchId, attemptId, stream) {
      assertBatchId(batchId);
      const handle = openBatch(batchId);
      const row = prepared(
        handle,
        "SELECT acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id = ? AND stream = ?",
      ).get(attemptId, stream) as { acknowledged_sequence: number } | undefined;
      return row?.acknowledged_sequence ?? -1;
    },

    recordWatermarks(input) {
      assertBatchId(input.batchId);
      const handle = openBatch(input.batchId);
      const upsert = prepared(
        handle,
        `INSERT INTO attempt_log_watermarks (attempt_id, stream, acknowledged_sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(attempt_id, stream) DO UPDATE SET
         acknowledged_sequence = MAX(attempt_log_watermarks.acknowledged_sequence, excluded.acknowledged_sequence),
         updated_at = excluded.updated_at`,
      );
      handle.client
        .transaction(() => {
          for (const stream of ["stdout", "stderr", "agent"] as const) {
            upsert.run(input.attemptId, stream, input.watermarks[stream], input.recordedAt);
          }
        })
        .immediate();
    },

    removeBatchStore(batchId) {
      assertBatchId(batchId);
      closeStore(batchId);
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(storePath(attemptLogsDirectory, batchId) + suffix);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },

    batchStoreStats(batchIds) {
      const stats = new Map<string, number>();
      for (const batchId of batchIds) {
        if (!BATCH_ID_PATTERN.test(batchId)) {
          stats.set(batchId, 0);
          continue;
        }
        let bytes = 0;
        for (const suffix of ["", "-wal"]) {
          const path = storePath(attemptLogsDirectory, batchId) + suffix;
          if (existsSync(/* turbopackIgnore: true */ path)) {
            bytes += statSync(/* turbopackIgnore: true */ path).size;
          }
        }
        stats.set(batchId, bytes);
      }
      return stats;
    },

    directoryBytes() {
      let bytes = 0;
      let entries = 0;
      for (const entry of readdirSync(attemptLogsDirectory)) {
        if (entries >= MAX_STAT_ENTRIES) break;
        const path = join(attemptLogsDirectory, entry);
        if (statSync(path).isFile()) bytes += statSync(path).size;
        entries += 1;
      }
      return bytes;
    },

    relativeStorePath(batchId) {
      assertBatchId(batchId);
      return `${basename(attemptLogsDirectory)}/${basename(storePath(attemptLogsDirectory, batchId))}`;
    },

    close() {
      for (const batchId of [...openStores.keys()]) closeStore(batchId);
    },
  };
}

function assertBatchId(batchId: string): void {
  // 批次 ID 直接参与文件路径，必须严格校验以防止路径注入。
  if (!BATCH_ID_PATTERN.test(batchId)) {
    throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
  }
}

function storePath(directory: string, batchId: string): string {
  return join(directory, `${batchId}.sqlite`);
}

type BatchStoreHandle = {
  client: Database.Database;
  /** 预编译语句缓存：better-sqlite3 的 prepare 每次解析 SQL，日志热路径按语句文本复用。 */
  statements: Map<string, Database.Statement>;
};

type StoredContentEncoding = "identity" | "gzip";

type StoredLogRow = {
  stream: AttemptLogStream;
  sequence: number;
  content: string | Buffer;
  content_encoding: StoredContentEncoding;
  size_bytes: number;
  recorded_at: string;
};

type EncodedLogChunk = Omit<AttemptLogChunkInput, "content"> & {
  plainContent: string;
  storedContent: Buffer;
  contentEncoding: StoredContentEncoding;
  sizeBytes: number;
  storedSizeBytes: number;
  contentSha256: string;
};

function ensureCompressionColumns(client: Database.Database): void {
  // 批次日志库不走主数据库迁移。常量默认值让旧库只修改表元数据，不扫描或
  // 重写可能达到 GiB 级的历史正文；旧行会继续按 identity 格式透明读取。
  ensureColumn(
    client,
    "content_encoding",
    `ALTER TABLE attempt_log_chunks ADD COLUMN content_encoding TEXT NOT NULL
     DEFAULT 'identity' CHECK (content_encoding IN ('identity', 'gzip'))`,
  );
  ensureColumn(
    client,
    "stored_size_bytes",
    "ALTER TABLE attempt_log_chunks ADD COLUMN stored_size_bytes INTEGER",
  );
  ensureColumn(
    client,
    "content_sha256",
    "ALTER TABLE attempt_log_chunks ADD COLUMN content_sha256 TEXT",
  );
}

function ensureColumn(client: Database.Database, column: string, statement: string): void {
  if (hasColumn(client, column)) return;
  try {
    client.exec(statement);
  } catch (error) {
    // Lite 的 Web 主进程和日志 lane、Full 的多个副本可能同时首次打开同一个
    // 旧批次库。另一连接已成功补列时视为幂等完成，其他失败保留原始 cause。
    if (hasColumn(client, column)) return;
    throw new Error(`批次日志库无法升级 ${column} 列。`, { cause: error });
  }
}

function hasColumn(client: Database.Database, column: string): boolean {
  return (client.pragma("table_info(attempt_log_chunks)") as Array<{ name: string }>).some(
    (candidate) => candidate.name === column,
  );
}

async function encodeLogChunk(chunk: AttemptLogChunkInput): Promise<EncodedLogChunk> {
  const plainContent = Buffer.from(chunk.content, "utf8");
  const contentSha256 = createHash("sha256").update(plainContent).digest("hex");
  if (plainContent.byteLength < MINIMUM_COMPRESSION_BYTES) {
    return encodedIdentityChunk(chunk, plainContent, contentSha256);
  }
  const compressed = await gzipAsync(plainContent, {
    level: zlibConstants.Z_DEFAULT_COMPRESSION,
  });
  if (compressed.byteLength > plainContent.byteLength - MINIMUM_COMPRESSION_SAVING_BYTES) {
    return encodedIdentityChunk(chunk, plainContent, contentSha256);
  }
  return {
    stream: chunk.stream,
    sequence: chunk.sequence,
    recordedAt: chunk.recordedAt,
    plainContent: chunk.content,
    storedContent: compressed,
    contentEncoding: "gzip",
    sizeBytes: plainContent.byteLength,
    storedSizeBytes: compressed.byteLength,
    contentSha256,
  };
}

function encodedIdentityChunk(
  chunk: AttemptLogChunkInput,
  content: Buffer,
  contentSha256: string,
): EncodedLogChunk {
  return {
    stream: chunk.stream,
    sequence: chunk.sequence,
    recordedAt: chunk.recordedAt,
    plainContent: chunk.content,
    storedContent: content,
    contentEncoding: "identity",
    sizeBytes: content.byteLength,
    storedSizeBytes: content.byteLength,
    contentSha256,
  };
}

function legacyContentEquals(stored: string | Buffer, expected: string): boolean {
  return (typeof stored === "string" ? stored : stored.toString("utf8")) === expected;
}

async function decodeStoredRows(rows: StoredLogRow[]): Promise<AttemptLogItem[]> {
  const items: AttemptLogItem[] = [];
  for (let offset = 0; offset < rows.length; offset += LOG_DECOMPRESSION_CONCURRENCY) {
    items.push(
      ...(await Promise.all(
        rows
          .slice(offset, offset + LOG_DECOMPRESSION_CONCURRENCY)
          .map((row) => decodeStoredRow(row)),
      )),
    );
  }
  return items;
}

async function decodeStoredRow(row: StoredLogRow): Promise<AttemptLogItem> {
  const storedContent =
    typeof row.content === "string" ? Buffer.from(row.content, "utf8") : row.content;
  let plainContent: Buffer;
  try {
    plainContent =
      row.content_encoding === "gzip" ? await gunzipAsync(storedContent) : storedContent;
  } catch (error) {
    throw new Error(`无法解压 ${row.stream} 日志块 ${row.sequence}，批次日志文件可能已经损坏。`, {
      cause: error,
    });
  }
  if (plainContent.byteLength !== row.size_bytes) {
    throw new Error(`${row.stream} 日志块 ${row.sequence} 解压后的字节数与保存元数据不一致。`);
  }
  return {
    stream: row.stream,
    sequence: row.sequence,
    content: plainContent.toString("utf8"),
    recordedAt: row.recorded_at,
  };
}
