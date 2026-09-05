import { opendir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { DomainError } from "@autoforge/domain";
import {
  nodeLogRequestSchema,
  type NodeLogRequest,
  type NodeLogResponse,
} from "@autoforge/contracts";
import type { AttemptLogStore, AttemptLogStream } from "./attempt-log-store";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { PostgresPlatformNodeRepository } from "./postgres-platform-nodes";
import type { NodeLogTransport } from "./platform-node-transport";

type Queryable = Pick<PoolClient, "query">;
const emptyWatermarks = { stdout: -1, stderr: -1, agent: -1 };

/** PostgreSQL owns location and acknowledgement metadata; only the owner writes the SQLite file. */
export class NodeAttemptLogStore {
  constructor(
    private readonly database: PostgresDatabaseHandle,
    readonly nodeId: string,
    private readonly local: AttemptLogStore,
    private readonly transport: NodeLogTransport,
    private readonly directory: string,
  ) {}

  async initialize(directory: string): Promise<void> {
    await new PostgresPlatformNodeRepository(this.database).register(
      this.nodeId,
      new Date().toISOString(),
    );
    // Existing files identify their original owner during a single-host upgrade. Never copy
    // these directories to a replica: conflicting ownership is rejected instead of overwritten.
    for await (const entry of await opendir(directory)) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.sqlite$/.test(entry.name)) continue;
      const batchId = entry.name.slice(0, -7);
      const batch = await this.database.pool.query("SELECT id FROM run_batches WHERE id=$1", [
        batchId,
      ]);
      if (!batch.rowCount) continue;
      const owner = await this.claimOwner(batchId);
      if (owner !== this.nodeId)
        throw new Error(`批次 ${batchId} 的本地日志与节点 ${owner} 的归属冲突。`);
      await this.updateStoredBytes(batchId);
      let afterId = "";
      for (;;) {
        const attempts = await this.database.pool.query<{ id: string }>(
          `SELECT a.id FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id
           WHERE r.batch_id=$1 AND a.id>$2 ORDER BY a.id LIMIT 200`,
          [batchId, afterId],
        );
        for (const { id } of attempts.rows) {
          await this.recordWatermarks({
            batchId,
            attemptId: id,
            recordedAt: new Date().toISOString(),
            watermarks: {
              stdout: this.local.acknowledgedSequence(batchId, id, "stdout"),
              stderr: this.local.acknowledgedSequence(batchId, id, "stderr"),
              agent: this.local.acknowledgedSequence(batchId, id, "agent"),
            },
          });
        }
        if (attempts.rows.length < 200) break;
        afterId = attempts.rows.at(-1)!.id;
      }
    }
  }

  async appendChunks(input: Parameters<AttemptLogStore["appendChunks"]>[0]) {
    const response = await this.route({ operation: "append", ...input });
    if (!response.watermarks)
      throw new Error("Log owner did not return acknowledgement watermarks.");
    await this.recordWatermarks({
      ...input,
      watermarks: response.watermarks,
      recordedAt: input.receivedAt,
    });
    return response.watermarks;
  }

  async listChunks(input: Parameters<AttemptLogStore["listChunks"]>[0]) {
    const response = await this.route({
      operation: "list",
      ...input,
      limit: Math.min(input.limit, 32),
    });
    if (!response.page) throw new Error("Log owner did not return a log page.");
    return response.page;
  }

  async acknowledgedSequence(
    _batchId: string,
    attemptId: string,
    stream: AttemptLogStream,
    client: Queryable = this.database.pool,
  ): Promise<number> {
    const result = await client.query<{ acknowledged_sequence: string }>(
      "SELECT acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id=$1 AND stream=$2",
      [attemptId, stream],
    );
    return Number(result.rows[0]?.acknowledged_sequence ?? -1);
  }

  async recordWatermarks(
    input: Parameters<AttemptLogStore["recordWatermarks"]>[0],
    client: Queryable = this.database.pool,
  ): Promise<void> {
    await client.query(
      `INSERT INTO attempt_log_watermarks (attempt_id,stream,acknowledged_sequence,updated_at)
       VALUES ($1,'stdout',$2,$5),($1,'stderr',$3,$5),($1,'agent',$4,$5)
       ON CONFLICT(attempt_id,stream) DO UPDATE SET acknowledged_sequence=GREATEST(
         attempt_log_watermarks.acknowledged_sequence,excluded.acknowledged_sequence),updated_at=excluded.updated_at`,
      [
        input.attemptId,
        input.watermarks.stdout,
        input.watermarks.stderr,
        input.watermarks.agent,
        input.recordedAt,
      ],
    );
  }

  async removeBatchStore(batchId: string): Promise<void> {
    await this.route({ operation: "remove", batchId });
    await this.database.pool.query(
      `DELETE FROM attempt_log_watermarks WHERE attempt_id IN (
        SELECT a.id FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id WHERE r.batch_id=$1)`,
      [batchId],
    );
  }

  async batchStoreStats(batchIds: readonly string[]): Promise<Map<string, number>> {
    const stats = new Map<string, number>();
    for (let offset = 0; offset < batchIds.length; offset += 500) {
      const result = await this.database.pool.query<{ batch_id: string; stored_bytes: string }>(
        "SELECT batch_id,stored_bytes FROM run_batch_log_locations WHERE batch_id=ANY($1::text[])",
        [batchIds.slice(offset, offset + 500)],
      );
      for (const row of result.rows) stats.set(row.batch_id, Number(row.stored_bytes));
    }
    return stats;
  }

  async directoryBytes(): Promise<number> {
    const result = await this.database.pool.query<{ bytes: string }>(
      "SELECT COALESCE(sum(stored_bytes),0) AS bytes FROM run_batch_log_locations",
    );
    return Number(result.rows[0]?.bytes ?? 0);
  }

  relativeStorePath(batchId: string): string {
    return this.local.relativeStorePath(batchId);
  }
  close(): void {
    this.local.close();
  }

  async cleanupOrphans(): Promise<void> {
    const result = await this.database.pool.query<{ batch_id: string }>(
      `SELECT l.batch_id FROM run_batch_log_locations l LEFT JOIN run_batches b ON b.id=l.batch_id
       WHERE b.id IS NULL AND l.node_id=$1 ORDER BY l.batch_id LIMIT 100`,
      [this.nodeId],
    );
    for (const { batch_id: batchId } of result.rows) {
      await this.removeBatchStore(batchId);
      await this.database.pool.query("DELETE FROM run_batch_log_locations WHERE batch_id=$1", [
        batchId,
      ]);
    }
  }

  async handlePeer(payload: NodeLogRequest): Promise<NodeLogResponse> {
    const request = nodeLogRequestSchema.parse(payload);
    const owner = await this.owner(request.batchId);
    if (owner !== this.nodeId)
      throw new DomainError("PLATFORM_LOG_OWNER_MISMATCH", "该节点不是此批次日志的所属节点。");
    const stats = await this.batchStoreStats([request.batchId]);
    if (
      request.operation !== "remove" &&
      (stats.get(request.batchId) ?? 0) > 0 &&
      (!this.directory || !existsSync(join(this.directory, `${request.batchId}.sqlite`)))
    ) {
      throw new DomainError(
        "PLATFORM_LOG_NODE_UNAVAILABLE",
        "所属节点的日志文件缺失，请恢复该节点的数据卷。",
      );
    }
    if (request.operation !== "remove") {
      const attempt = await this.database.pool.query(
        `SELECT a.id FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id
         WHERE a.id=$1 AND r.batch_id=$2`,
        [request.attemptId, request.batchId],
      );
      if (!attempt.rowCount)
        throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "执行尝试不属于此日志批次。");
    }
    const response: NodeLogResponse = { schemaVersion: 1, nodeId: this.nodeId };
    if (request.operation === "append") {
      response.watermarks = await this.local.appendChunks(request);
      await this.updateStoredBytes(request.batchId);
    } else if (request.operation === "list") {
      response.page = await this.local.listChunks({
        batchId: request.batchId,
        attemptId: request.attemptId,
        stream: request.stream,
        afterSequence: request.afterSequence,
        limit: request.limit,
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.recordedAfter !== undefined ? { recordedAfter: request.recordedAfter } : {}),
        ...(request.recordedBefore !== undefined ? { recordedBefore: request.recordedBefore } : {}),
      });
    } else {
      this.local.removeBatchStore(request.batchId);
      await this.updateStoredBytes(request.batchId);
    }
    return response;
  }

  private async route(request: NodeLogRequest): Promise<NodeLogResponse> {
    let owner = await this.owner(request.batchId);
    if (!owner) {
      const batch = await this.database.pool.query<{ attempt_logs_path: string | null }>(
        "SELECT attempt_logs_path FROM run_batches WHERE id=$1",
        [request.batchId],
      );
      if (batch.rows[0]?.attempt_logs_path)
        throw new DomainError(
          "PLATFORM_LOG_NODE_UNAVAILABLE",
          "历史日志尚未登记所属节点，请启动保存原始日志的平台节点。",
        );
      if (request.operation !== "append")
        return {
          schemaVersion: 1,
          nodeId: this.nodeId,
          page: { items: [], hasMore: false },
          watermarks: { ...emptyWatermarks },
        };
      if (!batch.rowCount) throw new DomainError("RUN_BATCH_NOT_FOUND", "执行批次不存在。");
      owner = await this.claimOwner(request.batchId);
    }
    if (owner === this.nodeId) return this.handlePeer(request);
    const node = await new PostgresPlatformNodeRepository(this.database).find(owner);
    if (!node?.internalBaseUrl)
      throw new DomainError(
        "PLATFORM_LOG_NODE_UNAVAILABLE",
        `请在平台节点设置中填写日志节点 ${owner} 的内部地址和端口。`,
      );
    return this.transport({ id: node.id, internalBaseUrl: node.internalBaseUrl }, request);
  }

  private async owner(batchId: string): Promise<string | undefined> {
    const result = await this.database.pool.query<{ node_id: string }>(
      "SELECT node_id FROM run_batch_log_locations WHERE batch_id=$1",
      [batchId],
    );
    return result.rows[0]?.node_id;
  }

  private async claimOwner(batchId: string): Promise<string> {
    await this.database.pool.query(
      "INSERT INTO run_batch_log_locations(batch_id,node_id) VALUES($1,$2) ON CONFLICT(batch_id) DO NOTHING",
      [batchId, this.nodeId],
    );
    const owner = await this.owner(batchId);
    if (!owner) throw new Error("Log location was not persisted.");
    return owner;
  }

  private async updateStoredBytes(batchId: string): Promise<void> {
    await this.database.pool.query(
      "UPDATE run_batch_log_locations SET stored_bytes=$2 WHERE batch_id=$1 AND node_id=$3",
      [batchId, this.local.batchStoreStats([batchId]).get(batchId) ?? 0, this.nodeId],
    );
  }
}
