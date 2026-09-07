import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { LogIoPool } from "./log-io-pool";

describe("isolated log disk I/O", () => {
  it("runs separate attempts on different threads while preserving each attempt's write order", async () => {
    const fixture = new URL(
      `data:text/javascript,${encodeURIComponent(`
      import { parentPort, threadId } from 'node:worker_threads';
      parentPort.on('message', request => {
        parentPort.postMessage({ id: request.id, ok: true, value: { threadId, sequence: request.args[0].sequence } });
      });
    `)}`,
    );
    const pool = new LogIoPool("unused", () => undefined, fixture, {
      readLanes: 2,
      writeLanes: 2,
      heapMb: 128,
    });
    try {
      const results = (await Promise.all([
        pool.call("appendChunks", [{ attemptId: "a", sequence: 0 }]),
        pool.call("appendChunks", [{ attemptId: "b", sequence: 0 }]),
        pool.call("recordWatermarks", [{ attemptId: "a", sequence: 1 }]),
      ])) as Array<{ threadId: number; sequence: number }>;
      expect(results[0]!.threadId).not.toBe(results[1]!.threadId);
      expect(results[0]!.threadId).toBe(results[2]!.threadId);
      expect(results.map((result) => result.sequence)).toEqual([0, 0, 1]);
    } finally {
      await pool.close();
    }
  });
  it("keeps HTTP and uploads responsive during a stuck reader, bounds its queue and recovers", async () => {
    const fixture = new URL(
      `data:text/javascript,${encodeURIComponent(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', request => {
        if (request.method === 'listChunks' && request.args[0] === 'stuck')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
        parentPort.postMessage({ id: request.id, ok: true, value: request.method });
      });
    `)}`,
    );
    const errors = vi.fn();
    const pool = new LogIoPool("unused", errors, fixture);
    const server = createServer((_request, response) => response.end("responsive"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address.");
    try {
      const blocked = Promise.allSettled(
        Array.from({ length: 16 }, () => pool.call("listChunks", ["stuck"])),
      );
      await expect(pool.call("listChunks", ["overflow"])).rejects.toMatchObject({
        code: "PLATFORM_LOG_BUSY",
      });
      const started = performance.now();
      await expect(pool.call("appendChunks", [{}])).resolves.toBe("appendChunks");
      for (let probe = 0; probe < 10; probe++) {
        const response = await fetch(`http://127.0.0.1:${address.port}`);
        expect(await response.text()).toBe("responsive");
      }
      expect(performance.now() - started).toBeLessThan(1_500);
      expect((await blocked).every((result) => result.status === "rejected")).toBe(true);
      await expect(pool.call("listChunks", ["recovered"])).resolves.toBe("listChunks");
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      await pool.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it("reads a large legacy SQLite store while writing another batch, without upgrading the legacy schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-log-io-"));
    const batchId = randomUUID();
    const path = join(directory, `${batchId}.sqlite`);
    const database = new Database(path);
    const content = "large legacy log\n".repeat(1024);
    database.exec(
      `CREATE TABLE attempt_log_chunks (attempt_id TEXT, stream TEXT, sequence INTEGER, content TEXT, size_bytes INTEGER, recorded_at TEXT, received_at TEXT, PRIMARY KEY (attempt_id,stream,sequence))`,
    );
    const insert = database.prepare(
      "INSERT INTO attempt_log_chunks VALUES ('attempt','stdout',?,?,?,'2026-09-07T00:00:00.000Z','2026-09-07T00:00:00.000Z')",
    );
    database.transaction(() => {
      for (let index = 0; index < 8192; index++)
        insert.run(index, content, Buffer.byteLength(content));
    })();
    const reportError = vi.fn();
    const pool = new LogIoPool(directory, reportError);
    try {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
      }, 5);
      try {
        const [page, watermarks] = await Promise.all([
          pool.call("listChunks", [
            { batchId, attemptId: "attempt", stream: "stdout", afterSequence: -1, limit: 500 },
          ]),
          pool.call("appendChunks", [
            {
              batchId: randomUUID(),
              attemptId: "live",
              receivedAt: "2026-09-07T00:00:00.000Z",
              chunks: [
                {
                  stream: "stdout",
                  sequence: 0,
                  content: "still uploading",
                  recordedAt: "2026-09-07T00:00:00.000Z",
                },
              ],
            },
          ]),
        ]);
        expect(page).toMatchObject({
          hasMore: true,
          items: expect.arrayContaining([expect.objectContaining({ sequence: 0, content })]),
        });
        expect(watermarks).toEqual({ stdout: 0, stderr: -1, agent: -1 });
        expect(ticks).toBeGreaterThan(0);
        expect(reportError).not.toHaveBeenCalled();
        const items = (page as { items: Array<{ content: string }> }).items;
        expect(
          items.reduce((bytes, item) => bytes + Buffer.byteLength(item.content), 0),
        ).toBeLessThanOrEqual(1024 * 1024);
        expect(
          (database.pragma("table_info(attempt_log_chunks)") as Array<{ name: string }>).some(
            (column) => column.name === "content_encoding",
          ),
        ).toBe(false);
      } finally {
        clearInterval(timer);
      }
    } finally {
      await pool.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
