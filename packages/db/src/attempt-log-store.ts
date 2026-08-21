import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

import Database from "better-sqlite3";
import { DomainError } from "@autoforge/domain";

// 用例日志从主数据库剥离后，每个执行批次使用一个独立 SQLite 文件。
// 这些文件是日志内容的唯一权威来源；批次删除或保留策略触发时整个文件被移除。
const BATCH_ID_PATTERN = /^[0-9a-f-]{8,64}$/;
const MAX_OPEN_STORES = 16;
// 目录字节统计的枚举上限；批次数量由保留策略控制，该上限只防御异常目录。
const MAX_STAT_ENTRIES = 10_000;

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
  }): { items: AttemptLogItem[]; hasMore: boolean };
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

  function openBatch(batchId: string): Database.Database {
    const cached = openStores.get(batchId);
    if (cached) {
      // LRU：命中后移到队尾，驱逐时总是关闭最久未用的句柄。
      openStores.delete(batchId);
      openStores.set(batchId, cached);
      return cached.client;
    }
    if (openStores.size >= MAX_OPEN_STORES) {
      const oldest = openStores.keys().next().value as string | undefined;
      if (oldest) closeStore(oldest);
    }
    const client = new Database(storePath(attemptLogsDirectory, batchId));
    client.pragma("journal_mode = WAL");
    client.pragma("foreign_keys = OFF");
    client.pragma("busy_timeout = 5000");
    client.exec(`
      CREATE TABLE IF NOT EXISTS attempt_log_chunks (
        attempt_id TEXT NOT NULL,
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'agent')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        content TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
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
    openStores.set(batchId, { client });
    return client;
  }

  function closeStore(batchId: string): void {
    const handle = openStores.get(batchId);
    if (!handle) return;
    openStores.delete(batchId);
    handle.client.pragma("wal_checkpoint(TRUNCATE)");
    handle.client.close();
  }

  function advanceWatermark(
    client: Database.Database,
    attemptId: string,
    stream: AttemptLogStream,
    updatedAt: string,
  ): number {
    // 水位推进语义与迁移前的主库实现一致：从当前水位起只承认严格连续的序号。
    const existing = client
      .prepare(
        "SELECT acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id = ? AND stream = ?",
      )
      .get(attemptId, stream) as { acknowledged_sequence: number } | undefined;
    let acknowledged = existing?.acknowledged_sequence ?? -1;
    const sequences = client
      .prepare(
        `SELECT sequence FROM attempt_log_chunks
         WHERE attempt_id = ? AND stream = ? AND sequence > ? ORDER BY sequence`,
      )
      .all(attemptId, stream, acknowledged) as Array<{ sequence: number }>;
    for (const row of sequences) {
      if (row.sequence !== acknowledged + 1) break;
      acknowledged = row.sequence;
    }
    client
      .prepare(
        `INSERT INTO attempt_log_watermarks (attempt_id, stream, acknowledged_sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(attempt_id, stream) DO UPDATE SET
         acknowledged_sequence = MAX(attempt_log_watermarks.acknowledged_sequence, excluded.acknowledged_sequence),
         updated_at = excluded.updated_at`,
      )
      .run(attemptId, stream, acknowledged, updatedAt);
    return acknowledged;
  }

  return {
    async appendChunks(input) {
      assertBatchId(input.batchId);
      const client = openBatch(input.batchId);
      return client.transaction(() => {
        for (const chunk of input.chunks) {
          const existing = client
            .prepare(
              `SELECT content, recorded_at FROM attempt_log_chunks
               WHERE attempt_id = ? AND stream = ? AND sequence = ?`,
            )
            .get(input.attemptId, chunk.stream, chunk.sequence) as
            { content: string; recorded_at: string } | undefined;
          if (existing) {
            if (existing.content !== chunk.content || existing.recorded_at !== chunk.recordedAt) {
              throw new DomainError("LOG_CHUNK_CONFLICT", "相同日志序号已保存不同内容。");
            }
            continue;
          }
          client
            .prepare(
              `INSERT INTO attempt_log_chunks
               (attempt_id, stream, sequence, content, size_bytes, recorded_at, received_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.attemptId,
              chunk.stream,
              chunk.sequence,
              chunk.content,
              Buffer.byteLength(chunk.content, "utf8"),
              chunk.recordedAt,
              input.receivedAt,
            );
        }
        return {
          stdout: advanceWatermark(client, input.attemptId, "stdout", input.receivedAt),
          stderr: advanceWatermark(client, input.attemptId, "stderr", input.receivedAt),
          agent: advanceWatermark(client, input.attemptId, "agent", input.receivedAt),
        };
      })();
    },

    listChunks(input) {
      assertBatchId(input.batchId);
      const client = openBatch(input.batchId);
      const clauses: string[] = [];
      const parameters: Array<string | number> = [
        input.attemptId,
        input.stream,
        input.afterSequence,
      ];
      if (input.query) {
        clauses.push("instr(content, ?) > 0");
        parameters.push(input.query);
      }
      if (input.recordedAfter) {
        clauses.push("recorded_at >= ?");
        parameters.push(input.recordedAfter);
      }
      if (input.recordedBefore) {
        clauses.push("recorded_at <= ?");
        parameters.push(input.recordedBefore);
      }
      parameters.push(input.limit + 1);
      const filters = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";
      const rows = client
        .prepare(
          `SELECT stream, sequence, content, recorded_at FROM attempt_log_chunks
           WHERE attempt_id = ? AND stream = ? AND sequence > ? ${filters}
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(...parameters) as Array<{
        stream: AttemptLogStream;
        sequence: number;
        content: string;
        recorded_at: string;
      }>;
      return {
        items: rows.slice(0, input.limit).map((row) => ({
          stream: row.stream,
          sequence: row.sequence,
          content: row.content,
          recordedAt: row.recorded_at,
        })),
        hasMore: rows.length > input.limit,
      };
    },

    acknowledgedSequence(batchId, attemptId, stream) {
      assertBatchId(batchId);
      const client = openBatch(batchId);
      const row = client
        .prepare(
          "SELECT acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id = ? AND stream = ?",
        )
        .get(attemptId, stream) as { acknowledged_sequence: number } | undefined;
      return row?.acknowledged_sequence ?? -1;
    },

    recordWatermarks(input) {
      assertBatchId(input.batchId);
      const client = openBatch(input.batchId);
      const upsert = client.prepare(
        `INSERT INTO attempt_log_watermarks (attempt_id, stream, acknowledged_sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(attempt_id, stream) DO UPDATE SET
         acknowledged_sequence = MAX(attempt_log_watermarks.acknowledged_sequence, excluded.acknowledged_sequence),
         updated_at = excluded.updated_at`,
      );
      client.transaction(() => {
        for (const stream of ["stdout", "stderr", "agent"] as const) {
          upsert.run(input.attemptId, stream, input.watermarks[stream], input.recordedAt);
        }
      })();
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
};
