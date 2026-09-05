import { randomUUID } from "node:crypto";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAttemptLogStore } from "../src/attempt-log-store";
import { createPostgresDatabase } from "../src/postgres-database";
import { NodeAttemptLogStore } from "../src/node-attempt-log-store";
import { PostgresPlatformNodeRepository } from "../src/postgres-platform-nodes";
import type { NodeLogTransport } from "../src/platform-node-transport";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const now = "2026-09-05T00:00:00.000Z";

describe.skipIf(!connectionString)("node-owned logs across isolated Full nodes", () => {
  it("chooses one owner under concurrent writes and shares gaps, duplicates, filters and acknowledgement metadata", async () => {
    const fixture = await createFixture();
    const { nodes, directories, batchId, attemptIds, handle } = fixture;
    try {
      const append = (sequence: number, content = `line-${sequence}`) => ({
        batchId,
        attemptId: attemptIds[0],
        receivedAt: now,
        chunks: [{ stream: "stdout" as const, sequence, content, recordedAt: now }],
      });
      await Promise.all([nodes[0].appendChunks(append(0)), nodes[1].appendChunks(append(2))]);
      expect(await nodes[1].acknowledgedSequence(batchId, attemptIds[0], "stdout")).toBe(0);
      expect((await nodes[1].appendChunks(append(1))).stdout).toBe(2);
      expect((await nodes[0].appendChunks(append(1))).stdout).toBe(2);
      await expect(nodes[1].appendChunks(append(1, "different"))).rejects.toThrow("相同日志序号");
      const owner = await handle.pool.query<{ node_id: string }>(
        "SELECT node_id FROM run_batch_log_locations WHERE batch_id=$1",
        [batchId],
      );
      expect(owner.rowCount).toBe(1);
      expect(
        directories.filter((directory) => existsSync(join(directory, `${batchId}.sqlite`))),
      ).toHaveLength(1);
      for (const node of nodes) {
        const page = await node.listChunks({
          batchId,
          attemptId: attemptIds[0],
          stream: "stdout",
          afterSequence: -1,
          limit: 2,
        });
        expect(page.items.map((item) => item.content)).toEqual(["line-0", "line-1"]);
        expect(page.hasMore).toBe(true);
        expect(
          (
            await node.listChunks({
              batchId,
              attemptId: attemptIds[0],
              stream: "stdout",
              afterSequence: -1,
              limit: 2,
              query: "line-2",
            })
          ).items.map((item) => item.sequence),
        ).toEqual([2]);
      }
      expect(await nodes[1].directoryBytes()).toBeGreaterThan(0);
      expect(
        (
          await handle.pool.query("SELECT * FROM attempt_log_chunks WHERE attempt_id=$1", [
            attemptIds[0],
          ])
        ).rowCount,
      ).toBe(0);
      await nodes[1].removeBatchStore(batchId);
      expect(
        (
          await nodes[0].listChunks({
            batchId,
            attemptId: attemptIds[0],
            stream: "stdout",
            afterSequence: -1,
            limit: 2,
          })
        ).items,
      ).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("reports unavailable owners without reassigning logs or creating a second file, and recovers after the owner returns", async () => {
    const fixture = await createFixture();
    const { nodes, directories, batchId, attemptIds } = fixture;
    const query = {
      batchId,
      attemptId: attemptIds[0],
      stream: "stdout" as const,
      afterSequence: -1,
      limit: 10,
    };
    try {
      await nodes[0].appendChunks({
        batchId,
        attemptId: attemptIds[0],
        receivedAt: now,
        chunks: [{ stream: "stdout", sequence: 0, content: "durable", recordedAt: now }],
      });
      fixture.disconnect();
      await expect(nodes[1].listChunks(query)).rejects.toThrow("offline");
      expect(existsSync(join(directories[1], `${batchId}.sqlite`))).toBe(false);
      fixture.reconnect();
      expect((await nodes[1].listChunks(query)).items[0]?.content).toBe("durable");
      nodes[0].close();
      const file = join(directories[0], `${batchId}.sqlite`);
      await rename(file, file + ".backup");
      await expect(nodes[1].listChunks(query)).rejects.toThrow("日志文件缺失");
      await rename(file + ".backup", file);
    } finally {
      await fixture.dispose();
    }
  });

  it("retains orphan locations so the original node can retry cleanup after a batch is deleted", async () => {
    const fixture = await createFixture();
    try {
      await fixture.nodes[0].appendChunks({
        batchId: fixture.batchId,
        attemptId: fixture.attemptIds[0],
        receivedAt: now,
        chunks: [{ stream: "stdout", sequence: 0, content: "cleanup", recordedAt: now }],
      });
      await fixture.handle.pool.query("DELETE FROM run_batches WHERE id=$1", [fixture.batchId]);
      await fixture.nodes[1].cleanupOrphans();
      expect(existsSync(join(fixture.directories[0], `${fixture.batchId}.sqlite`))).toBe(true);
      await fixture.nodes[0].cleanupOrphans();
      expect(existsSync(join(fixture.directories[0], `${fixture.batchId}.sqlite`))).toBe(false);
      expect(
        (
          await fixture.handle.pool.query(
            "SELECT * FROM run_batch_log_locations WHERE batch_id=$1",
            [fixture.batchId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await fixture.dispose();
    }
  });

  it("imports original-node logs and watermarks without allowing a replica to adopt missing history", async () => {
    const fixture = await createFixture();
    const { nodes, directories, batchId, attemptIds, handle } = fixture;
    const original = createAttemptLogStore(directories[0]);
    try {
      await original.appendChunks({
        batchId,
        attemptId: attemptIds[0],
        receivedAt: now,
        chunks: [{ stream: "stdout", sequence: 0, content: "before upgrade", recordedAt: now }],
      });
      original.close();
      await handle.pool.query("UPDATE run_batches SET attempt_logs_path=$2 WHERE id=$1", [
        batchId,
        original.relativeStorePath(batchId),
      ]);
      const query = {
        batchId,
        attemptId: attemptIds[0],
        stream: "stdout" as const,
        afterSequence: -1,
        limit: 10,
      };
      await expect(nodes[1].listChunks(query)).rejects.toThrow("历史日志尚未登记");
      expect(existsSync(join(directories[1], `${batchId}.sqlite`))).toBe(false);
      await nodes[0].initialize(directories[0]);
      expect(await nodes[1].acknowledgedSequence(batchId, attemptIds[0], "stdout")).toBe(0);
      expect((await nodes[1].listChunks(query)).items[0]?.content).toBe("before upgrade");

      const copied = createAttemptLogStore(directories[1]);
      try {
        await copied.appendChunks({
          batchId,
          attemptId: attemptIds[0],
          receivedAt: now,
          chunks: [{ stream: "stdout", sequence: 0, content: "incorrect copy", recordedAt: now }],
        });
      } finally {
        copied.close();
      }
      await expect(nodes[1].initialize(directories[1])).rejects.toThrow("归属冲突");
      expect((await nodes[0].listChunks(query)).items[0]?.content).toBe("before upgrade");
    } finally {
      original.close();
      await fixture.dispose();
    }
  });
});

async function createFixture() {
  const handle = createPostgresDatabase({
    connectionString: connectionString!,
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
  });
  await handle.ready;
  const runnerId = randomUUID();
  const batchId = randomUUID();
  const attemptIds = [randomUUID(), randomUUID()] as const;
  await handle.pool.query(
    `INSERT INTO runners
       (id, credential_hash, name, disabled, draining, os, architecture, agent_version,
        protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots,
        last_seen_at, created_at, updated_at)
     VALUES ($1, $1, 'Runner One', FALSE, FALSE, 'linux', 'amd64', '0.4.0',
             1, '{}', '[]', 2, 0, '2026-08-17T00:00:00.000Z',
             '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    [runnerId],
  );
  await handle.pool.query(
    `INSERT INTO run_batches
       (id, suite_id, suite_name, suite_version, status, retry_limit, total_runs,
        environment_json, created_at, updated_at)
     VALUES ($1, 'suite-1', '回归套件', 1, 'running', 3, 2, '[]',
             '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    [batchId],
  );
  await handle.pool.query(
    `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        status, attempt_count, created_at, updated_at)
     VALUES
       ($1, $3, $1, 1, 'run-1#method', 'com.example.RunOne',
        'running', 1, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
       ($2, $3, $2, 1, 'run-2#method', 'com.example.RunTwo',
        'running', 1, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    [attemptIds[0], attemptIds[1], batchId],
  );
  await handle.pool.query(
    `INSERT INTO run_attempts
       (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at)
     VALUES
       ($1, $1, $3, 1, 'running', 1.0, '2026-08-17T00:00:00.000Z'),
       ($2, $2, $3, 1, 'running', 1.0, '2026-08-17T00:00:00.000Z')`,
    [attemptIds[0], attemptIds[1], runnerId],
  );

  const directories = [
    await mkdtemp(join(tmpdir(), "node-logs-a-")),
    await mkdtemp(join(tmpdir(), "node-logs-b-")),
  ] as const;
  const nodeIds = [randomUUID(), randomUUID()] as const;
  let connected = true;
  const nodes: NodeAttemptLogStore[] = [];
  const transport: NodeLogTransport = async (node, request) => {
    if (!connected) throw new Error("owner offline");
    const destination = nodes.find((candidate) => candidate.nodeId === node.id);
    if (!destination) throw new Error("missing peer");
    return destination.handlePeer(request);
  };
  for (const [index, id] of nodeIds.entries()) {
    const directory = directories[index]!;
    const node = new NodeAttemptLogStore(
      handle,
      id,
      createAttemptLogStore(directory),
      transport,
      directory,
    );
    await node.initialize(directory);
    nodes.push(node);
    await new PostgresPlatformNodeRepository(handle).update(
      id,
      { name: `node-${index}`, internalBaseUrl: `http://127.0.0.1:${3300 + index}`, revision: 1 },
      now,
    );
  }
  return {
    handle,
    batchId,
    attemptIds,
    directories,
    nodes: nodes as [NodeAttemptLogStore, NodeAttemptLogStore],
    disconnect: () => {
      connected = false;
    },
    reconnect: () => {
      connected = true;
    },
    async dispose() {
      for (const node of nodes) node.close();
      await handle.pool.query("DELETE FROM run_batches WHERE id=$1", [batchId]);
      await handle.pool.query("DELETE FROM run_batch_log_locations WHERE batch_id=$1", [batchId]);
      await handle.pool.query("DELETE FROM platform_nodes WHERE id=ANY($1::text[])", [nodeIds]);
      await handle.pool.query("DELETE FROM runners WHERE id=$1", [runnerId]);
      await handle.close();
      for (const directory of directories) await rm(directory, { recursive: true, force: true });
    },
  };
}
