import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { beijingLogDay } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type { AttemptLogStore, AttemptLogStream } from "./attempt-log-store";
import type { PostgresLogDatabaseRepository } from "./postgres-log-databases";
import { appendPostgresLogChunks, readPostgresLogRows } from "./postgres-attempt-log-payload";
import { readAttemptLogPage } from "./attempt-log-pagination";

const streams = ["stdout", "stderr", "agent"] as const;
type AppendInput = Parameters<AttemptLogStore["appendChunks"]>[0];
export class PostgresDailyAttemptLogs {
  constructor(private readonly registry: PostgresLogDatabaseRepository) {}

  async append(serverId: string, input: AppendInput) {
    if (input.chunks.length > 256)
      throw new DomainError("LOG_CHUNKS_TOO_LARGE", "单次日志块数量超过限制。");
    const attempt = await this.registry.database.pool.query<{ created_at: string }>(
      "SELECT a.created_at FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id WHERE a.id=$1 AND r.batch_id=$2",
      [input.attemptId, input.batchId],
    );
    if (!attempt.rows[0])
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "日志对应的执行尝试不存在。");
    const earliest = Date.parse(attempt.rows[0].created_at) - 86400000;
    const latest = Date.parse(input.receivedAt) + 86400000;
    const groups = new Map<string, AppendInput["chunks"]>();
    const unique = new Map<string, string>();
    for (const chunk of input.chunks) {
      if (Buffer.byteLength(chunk.content) > 1024 * 1024)
        throw new DomainError("LOG_CHUNK_TOO_LARGE", "日志块超过 1 MiB。");
      const key = `${chunk.stream}:${chunk.sequence}`;
      const signature = createHash("sha256")
        .update(chunk.recordedAt)
        .update("\0")
        .update(chunk.content)
        .digest("hex");
      if (unique.has(key) && unique.get(key) !== signature)
        throw new DomainError("LOG_CHUNK_CONFLICT", "相同日志序号携带不同内容或时间。");
      unique.set(key, signature);
      const timestamp = Date.parse(chunk.recordedAt);
      if (!Number.isFinite(timestamp) || timestamp < earliest || timestamp > latest)
        throw new DomainError(
          "LOG_CHUNK_TIME_INVALID",
          "日志时间超出执行期间允许的时钟偏差范围，拒绝创建异常日期库。",
        );
      const day = beijingLogDay(chunk.recordedAt);
      const group = groups.get(day) ?? [];
      group.push(chunk);
      groups.set(day, group);
    }
    if (!groups.size) return this.watermarks(input.attemptId);
    const databases = new Map<string, AppendInput["chunks"]>();
    for (const [day, chunks] of groups) {
      const databaseId = await this.registry.daily.ensureDay(serverId, day);
      databases.set(databaseId, chunks);
    }
    const first = [...databases.keys()].sort()[0]!;
    await this.registry.database.pool.query(
      "INSERT INTO attempt_log_database_routes(attempt_id,batch_id,anchor_database_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [input.attemptId, input.batchId, first],
    );
    const anchor = await this.registry.database.pool.query<{ anchor_database_id: string }>(
      "SELECT anchor_database_id FROM attempt_log_database_routes WHERE attempt_id=$1 AND batch_id=$2",
      [input.attemptId, input.batchId],
    );
    if (!anchor.rows[0]) throw new DomainError("LOG_CHUNK_CONFLICT", "日志执行归属不一致。");
    const anchorId = anchor.rows[0].anchor_database_id;
    // Session locks use a separate bounded pool. Holding a payload connection while
    // opening another day's pool can deadlock concurrent cross-day uploads.
    return this.registry.withAttemptLock(anchorId, input.attemptId, async () => {
      for (const databaseId of databases.keys())
        await this.registry.database.pool.query(
          "INSERT INTO attempt_log_database_locations(attempt_id,batch_id,database_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [input.attemptId, input.batchId, databaseId],
        );
      const locations = await this.locations(input.attemptId);
      // A retransmitted sequence cannot change its date and escape deduplication by moving shards.
      if (locations.length > 1)
        for (const id of locations) {
          const check = async (query: Pick<Pool, "query">) => {
            const saved = await query.query<{
              stream: AttemptLogStream;
              sequence: string;
              recorded_at: string;
              content_sha256: string;
            }>(
              `SELECT l.stream,l.sequence,l.recorded_at,l.content_sha256 FROM log_chunks l
               JOIN unnest($3::text[],$4::bigint[]) c(stream,sequence) ON c.stream=l.stream AND c.sequence=l.sequence
               WHERE l.batch_id=$1 AND l.attempt_id=$2`,
              [
                input.batchId,
                input.attemptId,
                input.chunks.map((c) => c.stream),
                input.chunks.map((c) => c.sequence),
              ],
            );
            for (const row of saved.rows) {
              const incoming = input.chunks.find(
                (c) => c.stream === row.stream && c.sequence === Number(row.sequence),
              )!;
              if (
                incoming.recordedAt !== row.recorded_at ||
                createHash("sha256").update(incoming.content).digest("hex") !== row.content_sha256
              )
                throw new DomainError(
                  "LOG_CHUNK_CONFLICT",
                  "相同日志序号已在其他日期库保存不同内容。",
                );
            }
          };
          await this.registry.withDatabase(id, check);
        }
      let singleWatermarks: Record<AttemptLogStream, number> | undefined;
      for (const [id, chunks] of databases) {
        const result = await this.registry.withDatabase(id, (pool) =>
          appendPostgresLogChunks(pool, { ...input, chunks }),
        );
        singleWatermarks = result.watermarks;
        await this.registry.database.pool.query(
          `INSERT INTO run_batch_log_database_sizes(batch_id,database_id,stored_bytes) VALUES($1,$2,$3)
             ON CONFLICT(batch_id,database_id) DO UPDATE SET stored_bytes=GREATEST(run_batch_log_database_sizes.stored_bytes,excluded.stored_bytes)`,
          [input.batchId, id, result.storedBytes],
        );
      }
      const watermarks =
        locations.length === 1 ? singleWatermarks! : await this.contiguous(input, locations);
      await this.registry.database.pool.query(
        "UPDATE run_batch_log_storage SET stored_bytes=GREATEST(stored_bytes,(SELECT COALESCE(sum(stored_bytes),0) FROM run_batch_log_database_sizes WHERE batch_id=$1)) WHERE batch_id=$1",
        [input.batchId],
      );
      return watermarks;
    });
  }

  async list(input: Parameters<AttemptLogStore["listChunks"]>[0]) {
    const ids = await this.locations(input.attemptId);
    const { query: _query, ...unfiltered } = input;
    void _query;
    return readAttemptLogPage(input, async (after, limit) => {
      const collected = [];
      for (const id of ids) {
        const rows = await this.registry.withDatabase(id, (pool) =>
          readPostgresLogRows(pool, unfiltered, after, limit),
        );
        collected.push(...rows);
      }
      collected.sort((a, b) => a.sequence - b.sequence);
      return collected.slice(0, limit);
    });
  }

  private async locations(attemptId: string): Promise<string[]> {
    return (
      await this.registry.database.pool.query<{ database_id: string }>(
        "SELECT database_id FROM attempt_log_database_locations WHERE attempt_id=$1 ORDER BY database_id",
        [attemptId],
      )
    ).rows.map((r) => r.database_id);
  }
  private async watermarks(attemptId: string) {
    const result = { stdout: -1, stderr: -1, agent: -1 };
    const saved = await this.registry.database.pool.query<{
      stream: AttemptLogStream;
      acknowledged_sequence: string;
    }>("SELECT stream,acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id=$1", [
      attemptId,
    ]);
    for (const row of saved.rows) result[row.stream] = Number(row.acknowledged_sequence);
    return result;
  }
  private async contiguous(input: AppendInput, ids: string[]) {
    const result = await this.watermarks(input.attemptId);
    for (const stream of streams) {
      const sequences = new Set<number>();
      for (const id of ids) {
        const read = async (query: Pick<Pool, "query">) =>
          query.query<{ sequence: string }>(
            "SELECT sequence FROM log_chunks WHERE batch_id=$1 AND attempt_id=$2 AND stream=$3 AND sequence>$4 AND sequence<=$4+16384 ORDER BY sequence",
            [input.batchId, input.attemptId, stream, result[stream]],
          );
        const rows = await this.registry.withDatabase(id, read);
        for (const row of rows.rows) sequences.add(Number(row.sequence));
      }
      while (sequences.has(result[stream] + 1)) result[stream]++;
    }
    return result;
  }
}
