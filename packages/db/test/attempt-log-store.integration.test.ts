import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createAttemptLogStore } from "../src/attempt-log-store";
import { createSqliteDatabase } from "../src/database";

const temporaryDirectories: string[] = [];
const batchId = "00000000-0000-4000-8000-000000000a01";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AttemptLogStore", () => {
  it("returns empty logs while a new batch file is being initialized, then reads the first upload", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, `${batchId}.sqlite`);
    const initializing = new Database(path);
    initializing.pragma("journal_mode = WAL");
    const reader = createAttemptLogStore(directory);
    const writer = createAttemptLogStore(directory);
    const query = {
      batchId,
      attemptId: "new-attempt",
      stream: "stdout" as const,
      afterSequence: -1,
      limit: 10,
    };
    try {
      await expect(reader.listChunks(query)).resolves.toEqual({ items: [], hasMore: false });
      expect(reader.acknowledgedSequence(batchId, "new-attempt", "stdout")).toBe(-1);
      expect(
        initializing.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all(),
      ).toEqual([]);
      await writer.appendChunks({
        batchId,
        attemptId: "new-attempt",
        receivedAt: "2026-09-08T00:00:00.000Z",
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "new execution log",
            recordedAt: "2026-09-08T00:00:00.000Z",
          },
        ],
      });
      expect((await reader.listChunks(query)).items.map((chunk) => chunk.content)).toEqual([
        "new execution log",
      ]);
      expect(reader.acknowledgedSequence(batchId, "new-attempt", "stdout")).toBe(0);
    } finally {
      reader.close();
      writer.close();
      initializing.close();
    }
  });

  it("does not disguise a corrupt log database as pending logs", async () => {
    const directory = temporaryDirectory();
    const corrupt = new Database(join(directory, `${batchId}.sqlite`));
    corrupt.exec("CREATE TABLE unexpected_table(value TEXT)");
    corrupt.close();
    const reader = createAttemptLogStore(directory);
    try {
      await expect(
        reader.listChunks({
          batchId,
          attemptId: "attempt",
          stream: "stdout",
          afterSequence: -1,
          limit: 10,
        }),
      ).rejects.toThrow();
    } finally {
      reader.close();
    }
  });

  it("does not create a database when reading logs that have not arrived", async () => {
    const directory = temporaryDirectory();
    const store = createAttemptLogStore(directory);
    try {
      expect(
        await store.listChunks({
          batchId,
          attemptId: "missing",
          stream: "stdout",
          afterSequence: -1,
          limit: 10,
        }),
      ).toEqual({ items: [], hasMore: false });
      expect(store.acknowledgedSequence(batchId, "missing", "stdout")).toBe(-1);
      expect(existsSync(join(directory, `${batchId}.sqlite`))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("appends, lists and acknowledges chunks with gap, conflict and idempotent semantics", async () => {
    const store = createAttemptLogStore(temporaryDirectory());
    try {
      // 缺号（sequence 1 未到）时水位停留在 -1。
      await store.appendChunks({
        batchId,
        attemptId: "attempt-1",
        receivedAt: "2026-08-12T00:00:01.000Z",
        chunks: [
          {
            stream: "stdout",
            sequence: 2,
            content: "later",
            recordedAt: "2026-08-12T00:00:00.200Z",
          },
        ],
      });
      expect(store.acknowledgedSequence(batchId, "attempt-1", "stdout")).toBe(-1);

      // 补齐 0/1 后水位推进到连续段末尾。
      const watermark = await store.appendChunks({
        batchId,
        attemptId: "attempt-1",
        receivedAt: "2026-08-12T00:00:02.000Z",
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: "first",
            recordedAt: "2026-08-12T00:00:00.000Z",
          },
          {
            stream: "stdout",
            sequence: 1,
            content: "second",
            recordedAt: "2026-08-12T00:00:00.100Z",
          },
        ],
      });
      expect(watermark).toEqual({ stdout: 2, stderr: -1, agent: -1 });

      // 幂等重复：相同内容原样接受。
      const duplicate = await store.appendChunks({
        batchId,
        attemptId: "attempt-1",
        receivedAt: "2026-08-12T00:00:03.000Z",
        chunks: [
          {
            stream: "stdout",
            sequence: 1,
            content: "second",
            recordedAt: "2026-08-12T00:00:00.100Z",
          },
        ],
      });
      expect(duplicate.stdout).toBe(2);

      // 相同序号不同内容触发冲突。
      await expect(
        store.appendChunks({
          batchId,
          attemptId: "attempt-1",
          receivedAt: "2026-08-12T00:00:04.000Z",
          chunks: [
            {
              stream: "stdout",
              sequence: 1,
              content: "conflicting",
              recordedAt: "2026-08-12T00:00:00.100Z",
            },
          ],
        }),
      ).rejects.toThrowError(/相同日志序号/);

      const page = await store.listChunks({
        batchId,
        attemptId: "attempt-1",
        stream: "stdout",
        afterSequence: -1,
        limit: 10,
      });
      expect(page.items.map((item) => item.content)).toEqual(["first", "second", "later"]);
      expect(page.hasMore).toBe(false);

      const filtered = await store.listChunks({
        batchId,
        attemptId: "attempt-1",
        stream: "stdout",
        afterSequence: -1,
        limit: 2,
        query: "second",
      });
      expect(filtered.items.map((item) => item.sequence)).toEqual([1]);
    } finally {
      store.close();
    }
  });

  it("removes batch files and is idempotent for missing files", async () => {
    const directory = temporaryDirectory();
    const store = createAttemptLogStore(directory);
    await store.appendChunks({
      batchId,
      attemptId: "attempt-1",
      receivedAt: "2026-08-12T00:00:01.000Z",
      chunks: [
        { stream: "stdout", sequence: 0, content: "gone", recordedAt: "2026-08-12T00:00:00.000Z" },
      ],
    });
    expect(existsSync(join(directory, `${batchId}.sqlite`))).toBe(true);

    store.removeBatchStore(batchId);
    expect(existsSync(join(directory, `${batchId}.sqlite`))).toBe(false);
    expect(existsSync(join(directory, `${batchId}.sqlite-wal`))).toBe(false);

    // 文件不存在时不抛错。
    expect(() => store.removeBatchStore(batchId)).not.toThrow();
    store.close();
  });

  it("compresses beneficial chunks while preserving pagination, filters and idempotency", async () => {
    const directory = temporaryDirectory();
    const store = createAttemptLogStore(directory);
    const repeatedLine = "[main] INFO com.example.OrderTest - repeated diagnostic context\n";
    const chunks = Array.from({ length: 40 }, (_, sequence) => ({
      stream: "stdout" as const,
      sequence,
      content: `${repeatedLine.repeat(40)}sequence=${sequence}${
        sequence === 35 || sequence === 39 ? " compression-target" : ""
      }`,
      recordedAt: `2026-08-12T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    }));
    try {
      await store.appendChunks({
        batchId,
        attemptId: "attempt-compressed",
        receivedAt: "2026-08-12T00:01:00.000Z",
        chunks,
      });
      await store.appendChunks({
        batchId,
        attemptId: "attempt-small",
        receivedAt: "2026-08-12T00:01:00.000Z",
        chunks: [
          {
            stream: "agent",
            sequence: 0,
            content: "attempt started",
            recordedAt: "2026-08-12T00:00:00.000Z",
          },
        ],
      });
      await expect(
        store.appendChunks({
          batchId,
          attemptId: "attempt-compressed",
          receivedAt: "2026-08-12T00:01:01.000Z",
          chunks: [chunks[0]!],
        }),
      ).resolves.toMatchObject({ stdout: 39 });

      const firstMatch = await store.listChunks({
        batchId,
        attemptId: "attempt-compressed",
        stream: "stdout",
        afterSequence: -1,
        limit: 1,
        query: "compression-target",
      });
      expect(firstMatch.items).toEqual([expect.objectContaining({ sequence: 35 })]);
      expect(firstMatch.hasMore).toBe(true);
      const secondMatch = await store.listChunks({
        batchId,
        attemptId: "attempt-compressed",
        stream: "stdout",
        afterSequence: 35,
        limit: 1,
        query: "compression-target",
      });
      expect(secondMatch.items).toEqual([expect.objectContaining({ sequence: 39 })]);
      expect(secondMatch.hasMore).toBe(false);
    } finally {
      store.close();
    }

    const database = new Database(join(directory, `${batchId}.sqlite`), { readonly: true });
    try {
      const row = database
        .prepare(
          `SELECT content,content_encoding,size_bytes,stored_size_bytes,content_sha256
           FROM attempt_log_chunks WHERE attempt_id=? AND stream='stdout' AND sequence=0`,
        )
        .get("attempt-compressed") as {
        content: Buffer;
        content_encoding: string;
        size_bytes: number;
        stored_size_bytes: number;
        content_sha256: string;
      };
      expect(row.content_encoding).toBe("gzip");
      expect(Buffer.isBuffer(row.content)).toBe(true);
      expect(row.stored_size_bytes).toBe(row.content.byteLength);
      expect(row.stored_size_bytes).toBeLessThan(row.size_bytes / 2);
      expect(row.content_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        database
          .prepare(
            `SELECT content_encoding,size_bytes,stored_size_bytes
             FROM attempt_log_chunks WHERE attempt_id='attempt-small'`,
          )
          .get(),
      ).toEqual({
        content_encoding: "identity",
        size_bytes: Buffer.byteLength("attempt started"),
        stored_size_bytes: Buffer.byteLength("attempt started"),
      });
    } finally {
      database.close();
    }
  });

  it("prioritizes completed-log reads ahead of a bounded compression backlog", async () => {
    const store = createAttemptLogStore(temporaryDirectory());
    const publicAttemptId = "attempt-public";
    const compressibleContent = "public-log-compression-regression\n".repeat(128);
    try {
      await store.appendChunks({
        batchId,
        attemptId: publicAttemptId,
        receivedAt: "2026-08-12T00:01:00.000Z",
        chunks: [
          {
            stream: "stdout",
            sequence: 0,
            content: compressibleContent,
            recordedAt: "2026-08-12T00:00:00.000Z",
          },
        ],
      });

      const completionOrder: string[] = [];
      const compressionBacklog = store
        .appendChunks({
          batchId,
          attemptId: "attempt-batch-backlog",
          receivedAt: "2026-08-12T00:02:00.000Z",
          // 与 Runner Protocol 单次请求上限一致。旧实现会把 256 个 gzip 一次性
          // 提交到共享工作队列，使随后打开的公开日志只能等整个队列完成。
          chunks: Array.from({ length: 256 }, (_, sequence) => ({
            stream: "stdout" as const,
            sequence,
            content: `${compressibleContent}${sequence}`,
            recordedAt: "2026-08-12T00:01:30.000Z",
          })),
        })
        .then(() => completionOrder.push("batch-write"));
      const publicLogRead = store
        .listChunks({
          batchId,
          attemptId: publicAttemptId,
          stream: "stdout",
          afterSequence: -1,
          limit: 16,
        })
        .then((page) => {
          expect(page.items[0]?.content).toBe(compressibleContent);
          completionOrder.push("public-read");
        });
      const unrelatedPlatformRead = readFile(import.meta.filename).then(() => {
        completionOrder.push("platform-read");
      });

      await Promise.all([publicLogRead, unrelatedPlatformRead]);
      expect(completionOrder).toContain("public-read");
      expect(completionOrder).toContain("platform-read");
      expect(completionOrder).not.toContain("batch-write");
      await compressionBacklog;
      expect(completionOrder.at(-1)).toBe("batch-write");
    } finally {
      store.close();
    }
  });

  it("reopens an LRU-evicted batch between filtered decompression pages", async () => {
    const store = createAttemptLogStore(temporaryDirectory());
    const repeatedContent = "filtered compressed log line\n".repeat(64);
    try {
      await store.appendChunks({
        batchId,
        attemptId: "attempt-filtered",
        receivedAt: "2026-08-12T00:01:00.000Z",
        chunks: Array.from({ length: 40 }, (_, sequence) => ({
          stream: "stdout" as const,
          sequence,
          content: `${repeatedContent}${sequence === 39 ? "needle" : ""}`,
          recordedAt: "2026-08-12T00:00:00.000Z",
        })),
      });

      const filteredRead = store.listChunks({
        batchId,
        attemptId: "attempt-filtered",
        stream: "stdout",
        afterSequence: -1,
        limit: 1,
        query: "needle",
      });
      // listChunks 已进入首批异步解压；打开 16 个其他批次会把目标句柄逐出 LRU。
      for (let index = 0; index < 16; index += 1) {
        store.acknowledgedSequence(
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          "attempt-other",
          "stdout",
        );
      }

      await expect(filteredRead).resolves.toMatchObject({
        items: [{ sequence: 39, content: expect.stringContaining("needle") }],
        hasMore: false,
      });
    } finally {
      store.close();
    }
  });

  it("reads legacy stores without schema writes and upgrades only when appending", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, `${batchId}.sqlite`);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE attempt_log_chunks (
        attempt_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        content TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, stream, sequence)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO attempt_log_chunks
         (attempt_id,stream,sequence,content,size_bytes,recorded_at,received_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        "attempt-legacy",
        "stdout",
        0,
        "legacy plaintext",
        Buffer.byteLength("legacy plaintext"),
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:01.000Z",
      );
    legacy.close();

    const store = createAttemptLogStore(directory);
    try {
      await expect(
        store.listChunks({
          batchId,
          attemptId: "attempt-legacy",
          stream: "stdout",
          afterSequence: -1,
          limit: 10,
        }),
      ).resolves.toMatchObject({
        items: [{ sequence: 0, content: "legacy plaintext" }],
      });
      const untouched = new Database(path, { readonly: true });
      try {
        expect(
          (untouched.pragma("table_info(attempt_log_chunks)") as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        ).not.toContain("content_encoding");
        expect(store.acknowledgedSequence(batchId, "attempt-legacy", "stdout")).toBe(-1);
      } finally {
        untouched.close();
      }
      await store.appendChunks({
        batchId,
        attemptId: "attempt-new",
        receivedAt: "2026-08-12T00:00:02.000Z",
        chunks: [],
      });
    } finally {
      store.close();
    }

    const upgraded = new Database(path, { readonly: true });
    try {
      const columns = (
        upgraded.pragma("table_info(attempt_log_chunks)") as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toEqual(
        expect.arrayContaining(["content_encoding", "stored_size_bytes", "content_sha256"]),
      );
      expect(
        upgraded
          .prepare(
            `SELECT content,content_encoding,stored_size_bytes,content_sha256
             FROM attempt_log_chunks WHERE attempt_id='attempt-legacy'`,
          )
          .get(),
      ).toEqual({
        content: "legacy plaintext",
        content_encoding: "identity",
        stored_size_bytes: null,
        content_sha256: null,
      });
    } finally {
      upgraded.close();
    }
  });

  it("keeps the main database free of log tables", async () => {
    const directory = temporaryDirectory();
    const store = createAttemptLogStore(directory);
    await store.appendChunks({
      batchId,
      attemptId: "attempt-1",
      receivedAt: "2026-08-12T00:00:01.000Z",
      chunks: [
        {
          stream: "stdout",
          sequence: 0,
          content: "external",
          recordedAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    });
    store.close();

    const handle = createSqliteDatabase({
      databasePath: join(directory, "main.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    try {
      expect(
        handle.client
          .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'attempt_log_chunks'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      handle.close();
    }
  });

  it("rejects batch ids that could escape the log directory", async () => {
    const store = createAttemptLogStore(temporaryDirectory());
    try {
      await expect(
        store.appendChunks({
          batchId: "../escape",
          attemptId: "attempt-1",
          receivedAt: "2026-08-12T00:00:01.000Z",
          chunks: [
            { stream: "stdout", sequence: 0, content: "x", recordedAt: "2026-08-12T00:00:00.000Z" },
          ],
        }),
      ).rejects.toThrowError(/批次不存在/);
    } finally {
      store.close();
    }
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "autoforge-attempt-log-store-"));
  temporaryDirectories.push(directory);
  return directory;
}
