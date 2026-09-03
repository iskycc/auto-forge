import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
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

  it("upgrades and reads legacy uncompressed batch stores without rewriting their rows", async () => {
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
