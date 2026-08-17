import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  it("appends, lists and acknowledges chunks with gap, conflict and idempotent semantics", () => {
    const store = createAttemptLogStore(temporaryDirectory());
    try {
      // 缺号（sequence 1 未到）时水位停留在 -1。
      store.appendChunks({
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
      const watermark = store.appendChunks({
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
      const duplicate = store.appendChunks({
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
      expect(() =>
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
      ).toThrowError(/相同日志序号/);

      const page = store.listChunks({
        batchId,
        attemptId: "attempt-1",
        stream: "stdout",
        afterSequence: -1,
        limit: 10,
      });
      expect(page.items.map((item) => item.content)).toEqual(["first", "second", "later"]);
      expect(page.hasMore).toBe(false);

      const filtered = store.listChunks({
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

  it("removes batch files and is idempotent for missing files", () => {
    const directory = temporaryDirectory();
    const store = createAttemptLogStore(directory);
    store.appendChunks({
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

  it("keeps the main database free of log tables", () => {
    const directory = temporaryDirectory();
    const store = createAttemptLogStore(directory);
    store.appendChunks({
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

  it("rejects batch ids that could escape the log directory", () => {
    const store = createAttemptLogStore(temporaryDirectory());
    try {
      expect(() =>
        store.appendChunks({
          batchId: "../escape",
          attemptId: "attempt-1",
          receivedAt: "2026-08-12T00:00:01.000Z",
          chunks: [
            { stream: "stdout", sequence: 0, content: "x", recordedAt: "2026-08-12T00:00:00.000Z" },
          ],
        }),
      ).toThrowError(/批次不存在/);
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
