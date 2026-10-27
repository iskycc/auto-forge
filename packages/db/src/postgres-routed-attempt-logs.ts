import type { PoolClient } from "pg";
import { DomainError } from "@autoforge/domain";
import type { AsyncAttemptLogStore, AttemptLogStore, AttemptLogStream } from "./attempt-log-store";
import type { NodeAttemptLogStore } from "./node-attempt-log-store";
import { NodeAttemptLogStore as NodeLogStore } from "./node-attempt-log-store";
import { PostgresLogDatabaseRepository } from "./postgres-log-databases";
import { appendPostgresLogChunks, listPostgresLogChunks } from "./postgres-attempt-log-payload";

type Binding = { database_id: string | null; stored_bytes: string };
type Queryable = Pick<PoolClient, "query">;

/** Persist the route before payload I/O. A database switch only affects batches without a route. */
export class PostgresRoutedAttemptLogStore implements AsyncAttemptLogStore {
  constructor(
    private readonly registry: PostgresLogDatabaseRepository,
    private readonly legacy: AttemptLogStore | AsyncAttemptLogStore | NodeAttemptLogStore,
  ) {}

  async appendChunks(input: Parameters<AttemptLogStore["appendChunks"]>[0]) {
    const binding = await this.claim(input.batchId);
    if (!binding.database_id) return this.legacy.appendChunks(input);
    const persisted = await this.registry.withDatabase(binding.database_id, (pool) =>
      appendPostgresLogChunks(pool, input),
    );
    // Both metadata writes happen after the independent payload transaction committed. A crash
    // before this point is repaired by the same idempotent Agent upload, never acknowledged early.
    await this.registry.database.pool.query(
      "UPDATE run_batch_log_storage SET stored_bytes=GREATEST(stored_bytes,$2) WHERE batch_id=$1",
      [input.batchId, persisted.storedBytes],
    );
    await this.recordWatermarks({
      ...input,
      watermarks: persisted.watermarks,
      recordedAt: input.receivedAt,
    });
    return persisted.watermarks;
  }

  async listChunks(input: Parameters<AttemptLogStore["listChunks"]>[0]) {
    const binding = await this.find(input.batchId);
    if (!binding?.database_id) return this.legacy.listChunks(input);
    return this.registry.withDatabase(binding.database_id, async (pool) => {
      if (Number(binding.stored_bytes) > 0) {
        const batch = await pool.query("SELECT 1 FROM log_batches WHERE batch_id=$1", [
          input.batchId,
        ]);
        if (!batch.rowCount)
          throw new DomainError(
            "PLATFORM_LOG_DATABASE_UNAVAILABLE",
            `日志库 ${binding.database_id} 缺少已登记的批次日志，请检查备份恢复完整性。`,
          );
      }
      return listPostgresLogChunks(pool, input);
    });
  }

  async acknowledgedSequence(
    batchId: string,
    attemptId: string,
    stream: AttemptLogStream,
    client?: Queryable,
  ): Promise<number> {
    // All routed Full stores use the existing business transaction for completion watermarks.
    if (client) {
      const result = await client.query<{ acknowledged_sequence: string }>(
        "SELECT acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id=$1 AND stream=$2",
        [attemptId, stream],
      );
      if (result.rows[0]) return Number(result.rows[0].acknowledged_sequence);
      // Legacy single-host files predate shared watermarks. Only these use the isolated local reader.
      const binding = await client.query<Binding>(
        "SELECT database_id FROM run_batch_log_storage WHERE batch_id=$1",
        [batchId],
      );
      if (binding.rows[0]?.database_id) return -1;
      if (this.legacy instanceof NodeLogStore) return -1;
      return this.legacy.acknowledgedSequence(batchId, attemptId, stream);
    }
    const binding = await this.find(batchId);
    if (!binding?.database_id) return this.legacy.acknowledgedSequence(batchId, attemptId, stream);
    return this.acknowledgedSequence(batchId, attemptId, stream, this.registry.database.pool);
  }

  async recordWatermarks(
    input: Parameters<AttemptLogStore["recordWatermarks"]>[0],
    client?: Queryable,
  ): Promise<void> {
    const query = client ?? this.registry.database.pool;
    await query.query(
      `INSERT INTO attempt_log_watermarks(attempt_id,stream,acknowledged_sequence,updated_at)
       VALUES($1,'stdout',$2,$5),($1,'stderr',$3,$5),($1,'agent',$4,$5)
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
    if (!client && !(await this.find(input.batchId))?.database_id)
      await this.legacy.recordWatermarks(input);
  }

  async removeBatchStore(batchId: string): Promise<void> {
    const binding = await this.find(batchId);
    if (!binding?.database_id) await this.legacy.removeBatchStore(batchId);
    else
      await this.registry.withDatabase(binding.database_id, async (pool) => {
        await pool.query("DELETE FROM log_batches WHERE batch_id=$1", [batchId]);
      });
    // Keep a zero-size route while the batch exists: an old in-flight upload must not switch databases.
    await this.registry.database.pool.query(
      "UPDATE run_batch_log_storage SET stored_bytes=0 WHERE batch_id=$1",
      [batchId],
    );
    await this.registry.database.pool.query(
      "DELETE FROM attempt_log_watermarks WHERE attempt_id IN (SELECT a.id FROM run_attempts a JOIN execution_runs r ON r.id=a.execution_run_id WHERE r.batch_id=$1)",
      [batchId],
    );
  }

  async batchStoreStats(batchIds: readonly string[]): Promise<Map<string, number>> {
    const stats = await this.legacy.batchStoreStats(batchIds);
    for (let offset = 0; offset < batchIds.length; offset += 500) {
      const result = await this.registry.database.pool.query<Binding & { batch_id: string }>(
        "SELECT batch_id,database_id,stored_bytes FROM run_batch_log_storage WHERE database_id IS NOT NULL AND batch_id=ANY($1::text[])",
        [batchIds.slice(offset, offset + 500)],
      );
      for (const row of result.rows) stats.set(row.batch_id, Number(row.stored_bytes));
    }
    return stats;
  }
  async directoryBytes(): Promise<number> {
    const result = await this.registry.database.pool.query<{ bytes: string }>(
      "SELECT COALESCE(sum(stored_bytes),0) AS bytes FROM run_batch_log_storage WHERE database_id IS NOT NULL",
    );
    return (await this.legacy.directoryBytes()) + Number(result.rows[0]!.bytes);
  }
  relativeStorePath(batchId: string): string {
    return this.legacy.relativeStorePath(batchId);
  }
  async close(): Promise<void> {
    await Promise.all([this.registry.close(), this.legacy.close()]);
  }

  async cleanupOrphans(): Promise<void> {
    const result = await this.registry.database.pool.query<{ batch_id: string }>(
      "SELECT l.batch_id FROM run_batch_log_storage l LEFT JOIN run_batches b ON b.id=l.batch_id WHERE b.id IS NULL ORDER BY l.batch_id LIMIT 100",
    );
    for (const row of result.rows) {
      await this.removeBatchStore(row.batch_id);
      await this.registry.database.pool.query(
        "DELETE FROM run_batch_log_storage WHERE batch_id=$1",
        [row.batch_id],
      );
    }
  }
  private async find(batchId: string): Promise<Binding | undefined> {
    return (
      await this.registry.database.pool.query<Binding>(
        "SELECT database_id,stored_bytes FROM run_batch_log_storage WHERE batch_id=$1",
        [batchId],
      )
    ).rows[0];
  }
  private async claim(batchId: string): Promise<Binding> {
    const existing = await this.find(batchId);
    if (existing) return existing;
    const client = await this.registry.database.pool.connect();
    try {
      await client.query("BEGIN");
      // The setting row orders route creation against a concurrent active-database switch.
      const settings = await client.query<{ active_database_id: string | null }>(
        "SELECT active_database_id FROM log_database_settings WHERE id=1 FOR SHARE",
      );
      const batch = await client.query<{ attempt_logs_path: string | null }>(
        "SELECT attempt_logs_path FROM run_batches WHERE id=$1",
        [batchId],
      );
      if (!batch.rowCount) throw new DomainError("RUN_BATCH_NOT_FOUND", "执行批次不存在。");
      const owner = await client.query("SELECT 1 FROM run_batch_log_locations WHERE batch_id=$1", [
        batchId,
      ]);
      const databaseId =
        batch.rows[0]!.attempt_logs_path || owner.rowCount
          ? null
          : settings.rows[0]!.active_database_id;
      await client.query(
        "INSERT INTO run_batch_log_storage(batch_id,database_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [batchId, databaseId],
      );
      const selected = await client.query<Binding>(
        "SELECT database_id,stored_bytes FROM run_batch_log_storage WHERE batch_id=$1",
        [batchId],
      );
      await client.query("COMMIT");
      return selected.rows[0]!;
    } catch (cause) {
      try {
        await client.query("ROLLBACK");
      } catch (rollback) {
        throw new AggregateError([cause, rollback], "日志路由事务与回滚失败。");
      }
      throw cause;
    } finally {
      client.release();
    }
  }
}
