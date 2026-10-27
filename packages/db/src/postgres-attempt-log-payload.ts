import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { DomainError } from "@autoforge/domain";
import { readAttemptLogPage } from "./attempt-log-pagination";
import type { AttemptLogStore, AttemptLogStream } from "./attempt-log-store";

const streams = ["stdout", "stderr", "agent"] as const;
type AppendInput = Parameters<AttemptLogStore["appendChunks"]>[0];

/** One log database owns complete batches. No business table or cross-database transaction is used here. */
export async function appendPostgresLogChunks(pool: Pool, input: AppendInput) {
  if (input.chunks.length > 256)
    throw new DomainError("LOG_CHUNKS_TOO_LARGE", "单次日志块数量超过限制。");
  const chunks = new Map<string, AppendInput["chunks"][number] & { hash: string; bytes: Buffer }>();
  for (const chunk of input.chunks) {
    const bytes = Buffer.from(chunk.content, "utf8");
    if (bytes.length > 1024 * 1024)
      throw new DomainError("LOG_CHUNK_TOO_LARGE", "日志块超过 1 MiB。");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const key = `${chunk.stream}:${chunk.sequence}`;
    const previous = chunks.get(key);
    if (previous && (previous.hash !== hash || previous.recordedAt !== chunk.recordedAt))
      throw new DomainError("LOG_CHUNK_CONFLICT", "相同日志序号已保存不同内容。");
    chunks.set(key, { ...chunk, hash, bytes });
  }
  const encoded = [...chunks.values()];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO log_batches(batch_id) VALUES($1) ON CONFLICT DO NOTHING", [
      input.batchId,
    ]);
    await client.query(
      "INSERT INTO log_streams(batch_id,attempt_id,stream) SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING",
      [input.batchId, input.attemptId, streams],
    );
    // Fixed lock order serializes retransmission of this attempt, without locking other attempts.
    const existing = await client.query<{
      stream: AttemptLogStream;
      acknowledged_sequence: string;
    }>(
      "SELECT stream,acknowledged_sequence FROM log_streams WHERE batch_id=$1 AND attempt_id=$2 ORDER BY stream FOR UPDATE",
      [input.batchId, input.attemptId],
    );
    const inserted = await client.query<{ size_bytes: number }>(
      `INSERT INTO log_chunks(batch_id,attempt_id,stream,sequence,content,content_sha256,size_bytes,recorded_at,received_at)
       SELECT $1,$2,c.stream,c.sequence,c.content,c.hash,c.size,c.recorded,$9
       FROM unnest($3::text[],$4::bigint[],$5::bytea[],$6::text[],$7::integer[],$8::text[])
       AS c(stream,sequence,content,hash,size,recorded) ON CONFLICT DO NOTHING RETURNING size_bytes`,
      [
        input.batchId,
        input.attemptId,
        encoded.map((c) => c.stream),
        encoded.map((c) => c.sequence),
        encoded.map((c) => c.bytes),
        encoded.map((c) => c.hash),
        encoded.map((c) => c.bytes.length),
        encoded.map((c) => c.recordedAt),
        input.receivedAt,
      ],
    );
    const saved = await client.query<{
      stream: AttemptLogStream;
      sequence: string;
      content_sha256: string;
      recorded_at: string;
    }>(
      `SELECT l.stream,l.sequence,l.content_sha256,l.recorded_at FROM log_chunks l
       JOIN unnest($3::text[],$4::bigint[]) c(stream,sequence) ON c.stream=l.stream AND c.sequence=l.sequence
       WHERE l.batch_id=$1 AND l.attempt_id=$2`,
      [
        input.batchId,
        input.attemptId,
        encoded.map((c) => c.stream),
        encoded.map((c) => c.sequence),
      ],
    );
    for (const row of saved.rows) {
      const chunk = chunks.get(`${row.stream}:${row.sequence}`)!;
      if (chunk.hash !== row.content_sha256 || chunk.recordedAt !== row.recorded_at)
        throw new DomainError("LOG_CHUNK_CONFLICT", "相同日志序号已保存不同内容。");
    }
    const watermarks = { stdout: -1, stderr: -1, agent: -1 };
    for (const row of existing.rows) {
      let acknowledged = Number(row.acknowledged_sequence);
      // Bound each advancement window; a retransmission can continue a very large recovered backlog.
      const sequences = await client.query<{ sequence: string }>(
        "SELECT sequence FROM log_chunks WHERE batch_id=$1 AND attempt_id=$2 AND stream=$3 AND sequence>$4 ORDER BY sequence LIMIT 16384",
        [input.batchId, input.attemptId, row.stream, acknowledged],
      );
      for (const chunk of sequences.rows) {
        if (Number(chunk.sequence) !== acknowledged + 1) break;
        acknowledged = Number(chunk.sequence);
      }
      watermarks[row.stream] = acknowledged;
      await client.query(
        "UPDATE log_streams SET acknowledged_sequence=$4 WHERE batch_id=$1 AND attempt_id=$2 AND stream=$3",
        [input.batchId, input.attemptId, row.stream, acknowledged],
      );
    }
    const addedBytes = inserted.rows.reduce((total, row) => total + row.size_bytes, 0);
    const size = await client.query<{ stored_bytes: string }>(
      "UPDATE log_batches SET stored_bytes=stored_bytes+$2 WHERE batch_id=$1 RETURNING stored_bytes",
      [input.batchId, addedBytes],
    );
    await client.query("COMMIT");
    return { watermarks, storedBytes: Number(size.rows[0]!.stored_bytes) };
  } catch (cause) {
    try {
      await client.query("ROLLBACK");
    } catch (rollback) {
      throw new AggregateError([cause, rollback], "日志事务与回滚失败。");
    }
    throw cause;
  } finally {
    client.release();
  }
}

export async function listPostgresLogChunks(
  pool: Pool,
  input: Parameters<AttemptLogStore["listChunks"]>[0],
) {
  return readAttemptLogPage(input, async (after, limit) => {
    const rows = await pool.query<{
      stream: AttemptLogStream;
      sequence: string;
      content: Buffer;
      recorded_at: string;
    }>(
      `SELECT stream,sequence,content,recorded_at FROM log_chunks WHERE batch_id=$1 AND attempt_id=$2
       AND stream=$3 AND sequence>$4 AND ($5::text IS NULL OR recorded_at>=$5)
       AND ($6::text IS NULL OR recorded_at<=$6) ORDER BY sequence LIMIT $7`,
      [
        input.batchId,
        input.attemptId,
        input.stream,
        after,
        input.recordedAfter ?? null,
        input.recordedBefore ?? null,
        limit,
      ],
    );
    return rows.rows.map((row) => ({
      stream: row.stream,
      sequence: Number(row.sequence),
      content: row.content.toString("utf8"),
      recordedAt: row.recorded_at,
    }));
  });
}
