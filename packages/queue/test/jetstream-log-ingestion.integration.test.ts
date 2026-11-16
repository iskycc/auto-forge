import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, StorageType, RetentionPolicy, DiscardPolicy } from "nats";
import { describe, expect, it, vi } from "vitest";
import { createAttemptLogStore } from "../../db/src/attempt-log-store";
import { LocalObjectStore } from "../../object-store/src/local-object-store";
import { JetStreamLogIngestion } from "../src/jetstream-log-ingestion";
import type { LogIngestionPayload } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

const natsUrl = process.env.AUTOFORGE_TEST_NATS_URL;
describe.skipIf(!natsUrl)("durable log ingestion", () => {
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-log-ingestion-"));
    const objects = new LocalObjectStore(directory);
    await objects.ready();
    const logs = createAttemptLogStore(join(directory, "logs"));
    const connections = await Promise.all(
      Array.from({ length: 3 }, () => connect({ servers: natsUrl! })),
    );
    const namespace = randomUUID().replaceAll("-", "");
    const peers: JetStreamLogIngestion[] = [];
    const errors: unknown[] = [];
    const input = (sequence = 0, content = "中文 stdout 日志\n") => ({
      schemaVersion: 1 as const,
      batchId: "00000000-0000-7000-8000-000000000001",
      runId: "run",
      attemptId: "attempt",
      receivedAt: "2026-11-14T01:00:00.000Z",
      chunks: [
        { stream: "stdout" as const, sequence, content, recordedAt: "2026-11-14T01:00:00.000Z" },
      ],
    });
    return {
      objects,
      logs,
      connections,
      input,
      errors,
      async peer(
        persist: (
          payload: LogIngestionPayload,
        ) => Promise<{ stdout: number; stderr: number; agent: number }> = async (payload) =>
          logs.appendChunks(payload),
        timeout = 25_000,
      ) {
        const peer = await JetStreamLogIngestion.create({
          connection: connections[peers.length]!,
          objects,
          persist,
          namespace,
          reportError: (error) => errors.push(error),
          confirmationTimeoutMs: timeout,
          concurrency: 4,
        });
        peers.push(peer);
        return peer;
      },
      async stream() {
        return (await connections[0]!.jetstreamManager()).streams.info(
          `AUTOFORGE_LOG_INGESTION_V1_${namespace.toUpperCase()}`,
        );
      },
      async close() {
        try {
          await Promise.all(peers.map((peer) => peer.close()));
        } finally {
          try {
            await (
              await connections[0]!.jetstreamManager()
            ).streams.delete(`AUTOFORGE_LOG_INGESTION_V1_${namespace.toUpperCase()}`);
          } finally {
            await Promise.all(connections.map((connection) => connection.drain()));
            logs.close();
            await rm(directory, { recursive: true, force: true });
          }
        }
      },
    };
  }

  it("persists only references in JetStream and does not acknowledge Agent logs until the database commits", async () => {
    const harness = await fixture();
    const gate = deferred();
    const called = deferred();
    let settled = false;
    try {
      const writer = await harness.peer(async (input) => {
        called.resolve();
        await gate.promise;
        return harness.logs.appendChunks(input);
      });
      const pending = writer.persist(harness.input()).then((watermarks) => {
        settled = true;
        return watermarks;
      });
      await called.promise;
      expect(settled).toBe(false);
      expect(
        harness.logs.acknowledgedSequence(
          "00000000-0000-7000-8000-000000000001",
          "attempt",
          "stdout",
        ),
      ).toBe(-1);
      const info = await harness.stream();
      const queued = await harness.connections[0]!.jetstream().streams.get(info.config.name);
      const message = await queued.getMessage({ seq: info.state.first_seq });
      expect(new TextDecoder().decode(message.data)).not.toContain("中文 stdout");
      gate.resolve();
      await expect(pending).resolves.toEqual({ stdout: 0, stderr: -1, agent: -1 });
      expect(
        (
          await harness.logs.listChunks({
            batchId: "00000000-0000-7000-8000-000000000001",
            attemptId: "attempt",
            stream: "stdout",
            afterSequence: -1,
            limit: 10,
          })
        ).items[0]?.content,
      ).toBe("中文 stdout 日志\n");
      expect(harness.errors).toEqual([]);
    } finally {
      gate.resolve();
      await harness.close();
    }
  });

  it("retries a transient writer failure and preserves duplicate, gap and conflicting-sequence semantics", async () => {
    const harness = await fixture();
    let failNext = true;
    try {
      const writer = await harness.peer(async (input) => {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error("injected lock timeout"), { code: "55P03" });
        }
        return harness.logs.appendChunks(input);
      });
      await expect(writer.persist(harness.input())).resolves.toMatchObject({ stdout: 0 });
      await expect(writer.persist(harness.input())).resolves.toMatchObject({ stdout: 0 });
      await expect(writer.persist(harness.input(2))).resolves.toMatchObject({ stdout: 0 });
      await expect(writer.persist(harness.input(1))).resolves.toMatchObject({ stdout: 2 });
      await expect(writer.persist(harness.input(0, "changed payload"))).rejects.toMatchObject({
        code: "LOG_CHUNK_CONFLICT",
      });
      expect(
        (
          await harness.logs.listChunks({
            batchId: "00000000-0000-7000-8000-000000000001",
            attemptId: "attempt",
            stream: "stdout",
            afterSequence: -1,
            limit: 10,
          })
        ).items,
      ).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it("removes staging immediately when a full stream definitively rejects its reference", async () => {
    const harness = await fixture();
    const gate = deferred();
    const called = deferred();
    try {
      const writer = await harness.peer(async (input) => {
        called.resolve();
        await gate.promise;
        return harness.logs.appendChunks(input);
      });
      const info = await harness.stream();
      await (
        await harness.connections[0]!.jetstreamManager()
      ).streams.update(info.config.name, { max_msgs: 1 });
      const first = writer.persist(harness.input());
      await called.promise;
      await expect(
        writer.persist({ ...harness.input(), attemptId: "second-attempt" }),
      ).rejects.toMatchObject({ code: "PLATFORM_LOG_BUSY" });
      expect(
        (await harness.objects.list({ prefix: "log-ingestion/v1/", limit: 200 })).items,
      ).toHaveLength(1);
      gate.resolve();
      await expect(first).resolves.toMatchObject({ stdout: 0 });
    } finally {
      gate.resolve();
      await harness.close();
    }
  });

  it("keeps a timed-out upload unconfirmed and supports retransmission after the writer completes", async () => {
    const harness = await fixture();
    const gate = deferred();
    let blocked = true;
    try {
      const writer = await harness.peer(async (input) => {
        if (blocked) await gate.promise;
        return harness.logs.appendChunks(input);
      }, 100);
      await expect(writer.persist(harness.input())).rejects.toMatchObject({
        code: "PLATFORM_LOG_BUSY",
      });
      expect(
        harness.logs.acknowledgedSequence(
          "00000000-0000-7000-8000-000000000001",
          "attempt",
          "stdout",
        ),
      ).toBe(-1);
      blocked = false;
      gate.resolve();
      await vi.waitFor(() =>
        expect(
          harness.logs.acknowledgedSequence(
            "00000000-0000-7000-8000-000000000001",
            "attempt",
            "stdout",
          ),
        ).toBe(0),
      );
      await expect(writer.persist(harness.input())).resolves.toMatchObject({ stdout: 0 });
    } finally {
      gate.resolve();
      await harness.close();
    }
  });

  it("bounds the complete upload deadline while staging is blocked and retains capacity until I/O actually settles", async () => {
    const harness = await fixture();
    const gate = deferred();
    const put = vi.spyOn(harness.objects, "putObject").mockImplementation(async (input) => {
      await gate.promise;
      return { objectKey: input.objectKey, created: true };
    });
    let settled = 0;
    const pending: Promise<void>[] = [];
    try {
      const writer = await harness.peer(undefined, 50);
      for (let index = 0; index < 256; index++) {
        pending.push(
          writer.persist({ ...harness.input(), attemptId: `blocked-${index}` }).then(
            () => {
              throw new Error("Blocked staging must not confirm a log.");
            },
            (error: unknown) => {
              expect(error).toMatchObject({ code: "PLATFORM_LOG_BUSY" });
              settled++;
            },
          ),
        );
      }
      await vi.waitFor(() => expect(settled).toBe(256), { timeout: 1_000 });
      await expect(writer.persist(harness.input())).rejects.toMatchObject({
        code: "PLATFORM_LOG_BUSY",
      });
      // Timing out the HTTP wait must not release an ongoing transfer's actual
      // byte/request reservation and admit an unbounded second wave of I/O.
      expect(put).toHaveBeenCalledTimes(256);
    } finally {
      gate.resolve();
      await Promise.all(pending);
      await harness.close();
      put.mockRestore();
    }
  });

  it("settles a staging upload on shutdown and never publishes it after the delayed transfer resumes", async () => {
    const harness = await fixture();
    const gate = deferred();
    const started = deferred();
    const removed = vi.spyOn(harness.objects, "delete");
    const put = vi.spyOn(harness.objects, "putObject").mockImplementation(async (input) => {
      started.resolve();
      await gate.promise;
      return { objectKey: input.objectKey, created: true };
    });
    let rejected = false;
    let upload: Promise<void> | undefined;
    try {
      const writer = await harness.peer();
      upload = writer.persist(harness.input()).then(
        () => {
          throw new Error("A closing writer cannot confirm staging-only data.");
        },
        (error: unknown) => {
          expect(error).toMatchObject({ code: "PLATFORM_LOG_BUSY" });
          rejected = true;
        },
      );
      await started.promise;
      await writer.close();
      await vi.waitFor(() => expect(rejected).toBe(true), { timeout: 500 });
      gate.resolve();
      await upload;
      await vi.waitFor(() => expect(removed).toHaveBeenCalledOnce());
      expect((await harness.stream()).state.messages).toBe(0);
    } finally {
      gate.resolve();
      await upload;
      await harness.close();
      put.mockRestore();
      removed.mockRestore();
    }
  });

  it("rejects an existing volatile log stream instead of silently accepting weaker durability", async () => {
    const harness = await fixture();
    try {
      const writer = await harness.peer();
      const info = await harness.stream();
      await writer.close();
      const manager = await harness.connections[0]!.jetstreamManager();
      await manager.streams.delete(info.config.name);
      await manager.streams.add({
        name: info.config.name,
        subjects: info.config.subjects,
        storage: StorageType.Memory,
        retention: RetentionPolicy.Workqueue,
        discard: DiscardPolicy.New,
      });
      await expect(harness.peer()).rejects.toThrow(/incompatible|persistent/i);
    } finally {
      await harness.close();
    }
  });

  it("preserves archived-log rejection without retrying a permanent failure or confirming data", async () => {
    const harness = await fixture();
    const persist = vi.fn(async () => {
      throw new DomainError("LOG_ARCHIVE_READ_ONLY", "archived logs are read-only");
    });
    try {
      const writer = await harness.peer(persist);
      await expect(writer.persist(harness.input())).rejects.toMatchObject({
        code: "LOG_ARCHIVE_READ_ONLY",
      });
      expect(persist).toHaveBeenCalledOnce();
      expect(
        harness.logs.acknowledgedSequence(
          "00000000-0000-7000-8000-000000000001",
          "attempt",
          "stdout",
        ),
      ).toBe(-1);
    } finally {
      await harness.close();
    }
  });

  it("lets three independently connected writers share one durable consumer without consuming dispatch jobs", async () => {
    const harness = await fixture();
    const consumers = new Set<number>();
    try {
      const writers: JetStreamLogIngestion[] = [];
      for (let index = 0; index < 3; index++)
        writers.push(
          await harness.peer(async (input) => {
            consumers.add(index);
            return harness.logs.appendChunks(input);
          }),
        );
      // Existing peers are intentionally independent NATS connections, as in
      // one Web plus two Workers. Every upload still persists before success.
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          writers[index % 3]!.persist({ ...harness.input(), attemptId: `attempt-${index}` }),
        ),
      );
      expect(results).toHaveLength(24);
      expect(results.every((watermarks) => watermarks.stdout === 0)).toBe(true);
      expect(consumers.size).toBeGreaterThan(1);
      expect(harness.errors).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
