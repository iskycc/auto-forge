import type { ReadModelLease, ReadModelSnapshotRepository } from "@autoforge/application";
import {
  PAGE_BLOCKING_READ_MODEL_KINDS,
  READ_MODEL_CLEANUP_PARTS_PER_SNAPSHOT,
} from "@autoforge/application";
import { readModelQuerySchema, type ReadModelQuery } from "@autoforge/contracts";
import { runPostgresTransaction } from "./postgres-transaction";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { readModelSnapshotFromRow, type ReadModelSnapshotRow } from "./read-model-snapshot-row";

const MAXIMUM_BATCH_LEASE_PROBES = 8;

export class PostgresReadModelSnapshotRepository implements ReadModelSnapshotRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async request(id: string, query: ReadModelQuery, now: string) {
    await this.handle.ready;
    const activeSince = new Date(Date.parse(now) - 60_000).toISOString();
    // Even a no-op ON CONFLICT takes a row lock. Hot reads must stay read-only.
    const recent = await this.handle.pool.query<ReadModelSnapshotRow>(
      "SELECT * FROM read_model_snapshots WHERE id=$1 AND accessed_at>=$2",
      [id, activeSince],
    );
    if (recent.rows[0]) return readModelSnapshotFromRow(recent.rows[0]);
    await this.handle.pool.query(
      `INSERT INTO read_model_snapshots (id,project_id,query_json,accessed_at,refresh_after)
      VALUES ($1,$2,$3,$4,$4) ON CONFLICT(id) DO UPDATE SET accessed_at=excluded.accessed_at
      WHERE read_model_snapshots.accessed_at<$5`,
      [id, query.projectId, JSON.stringify(query), now, activeSince],
    );
    const snapshot = await this.get(id);
    if (!snapshot) throw new Error(`Read model ${id} disappeared after registration.`);
    return snapshot;
  }

  async get(id: string) {
    await this.handle.ready;
    const result = await this.handle.pool.query<ReadModelSnapshotRow>(
      "SELECT * FROM read_model_snapshots WHERE id=$1",
      [id],
    );
    return result.rows[0] ? readModelSnapshotFromRow(result.rows[0]) : null;
  }

  async claim(now: string, expiresAt: string, token: string, options?: { onlyPageBlocking: true }) {
    await this.handle.ready;
    const candidateSql = `SELECT candidate.id,candidate.query_json FROM read_model_snapshots candidate
      WHERE candidate.refresh_after<=$1
        AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at<=$1)
        AND candidate.failed<5 AND candidate.accessed_at>=$2
        AND ($3::boolean=FALSE OR candidate.generated_at IS NULL OR
          (candidate.requested_revision>candidate.generated_revision AND
           candidate.query_json::jsonb->>'kind'=ANY($5::text[])))
        AND COALESCE(candidate.query_json::jsonb->>'batchId','')<>ALL($4::text[])
        AND NOT EXISTS (
          SELECT 1 FROM read_model_snapshots busy
          WHERE busy.id<>candidate.id AND busy.lease_token IS NOT NULL AND busy.lease_expires_at>$1
            AND busy.query_json::jsonb->>'batchId'=candidate.query_json::jsonb->>'batchId'
        )
      ORDER BY CASE WHEN candidate.generated_at IS NULL THEN 0 ELSE 1 END,candidate.refresh_after,candidate.id
      LIMIT 1`;
    const candidateParameters = (excludedBatches: string[]) => [
      now,
      new Date(Date.parse(now) - 300_000).toISOString(),
      options?.onlyPageBlocking ?? false,
      excludedBatches,
      PAGE_BLOCKING_READ_MODEL_KINDS,
    ];
    // Keep idle polling read-only. The transaction reselects and grants the actual lease.
    if (!(await this.handle.pool.query(candidateSql, candidateParameters([]))).rowCount)
      return null;
    return runPostgresTransaction(this.handle, async (client) => {
      // The post-lock check needs a fresh statement snapshot, including when the DB default is stricter.
      await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const excludedBatches: string[] = [];
      // A racing claimant can take a batch after our probe. Try other batches within a bounded window.
      for (let probe = 0; probe < MAXIMUM_BATCH_LEASE_PROBES; probe++) {
        const candidate = (
          await client.query<Pick<ReadModelSnapshotRow, "id" | "query_json">>(
            candidateSql + " FOR UPDATE OF candidate SKIP LOCKED",
            candidateParameters(excludedBatches),
          )
        ).rows[0];
        if (!candidate) return null;
        const query = readModelQuerySchema.parse(JSON.parse(candidate.query_json));
        const batchId = "batchId" in query ? query.batchId : undefined;
        if (batchId) {
          const lock = await client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended('autoforge:snapshot-batch:' || 'read_model_snapshots'::regclass::oid::text || ':' || $1,0)) AS acquired",
            [batchId],
          );
          if (!lock.rows[0]!.acquired) {
            excludedBatches.push(batchId);
            continue;
          }
          // Recheck in a fresh statement snapshot after locking: another transaction may
          // have committed its different query lease after our candidate SELECT began.
          const busy = await client.query(
            `SELECT 1 FROM read_model_snapshots WHERE lease_token IS NOT NULL AND lease_expires_at>$1
              AND query_json::jsonb->>'batchId'=$2 LIMIT 1`,
            [now, batchId],
          );
          if (busy.rowCount) {
            excludedBatches.push(batchId);
            continue;
          }
        }
        const result = await client.query<ReadModelSnapshotRow>(
          "UPDATE read_model_snapshots SET lease_token=$1,lease_expires_at=$2 WHERE id=$3 RETURNING *",
          [token, expiresAt, candidate.id],
        );
        return result.rows[0] ? { ...readModelSnapshotFromRow(result.rows[0]), token } : null;
      }
      return null;
    });
  }

  async renew(lease: ReadModelLease, now: string, expiresAt: string) {
    const result = await this.handle.pool.query(
      `UPDATE read_model_snapshots SET lease_expires_at=$1 WHERE id=$2 AND lease_token=$3 AND requested_revision=$4 AND lease_expires_at>$5`,
      [expiresAt, lease.id, lease.token, lease.requestedRevision, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async complete(
    lease: ReadModelLease,
    payload: unknown,
    generatedAt: string,
    refreshAfter: string,
  ) {
    const result = await this.handle.pool.query(
      `UPDATE read_model_snapshots SET payload_json=$1,generation=$2,generated_at=$3,
      refresh_after=$4,generated_revision=$5,lease_token=NULL,lease_expires_at=NULL,failed=0
      WHERE id=$6 AND lease_token=$2 AND requested_revision=$5 AND lease_expires_at>$3`,
      [
        JSON.stringify(payload),
        lease.token,
        generatedAt,
        refreshAfter,
        lease.requestedRevision,
        lease.id,
      ],
    );
    if (!result.rowCount)
      await this.handle.pool.query(
        "UPDATE read_model_snapshots SET lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2",
        [lease.id, lease.token],
      );
    return (result.rowCount ?? 0) > 0;
  }

  async fail(lease: ReadModelLease, retryAt: string, options?: { deferred: true }) {
    await this.handle.pool.query(
      `UPDATE read_model_snapshots SET failed=CASE WHEN requested_revision=$1 THEN failed+$5 ELSE 0 END,refresh_after=CASE WHEN requested_revision=$1 THEN $2 ELSE refresh_after END,
      lease_token=NULL,lease_expires_at=NULL WHERE id=$3 AND lease_token=$4`,
      [lease.requestedRevision, retryAt, lease.id, lease.token, options?.deferred ? 0 : 1],
    );
  }

  async invalidate(projectId: string, now: string) {
    await this.handle.ready;
    await this.handle.pool.query(
      "UPDATE read_model_snapshots SET requested_revision=requested_revision+1,failed=0,refresh_after=$1 WHERE project_id=$2",
      [now, projectId],
    );
  }

  async putPart(lease: ReadModelLease, ordinal: number, payload: unknown) {
    await this.handle.pool.query(
      `INSERT INTO read_model_snapshot_parts (snapshot_id,generation,ordinal,payload_json) VALUES ($1,$2,$3,$4)
      ON CONFLICT(snapshot_id,generation,ordinal) DO UPDATE SET payload_json=excluded.payload_json`,
      [lease.id, lease.token, ordinal, JSON.stringify(payload)],
    );
  }

  async getPart(id: string, generation: string, ordinal: number) {
    await this.handle.ready;
    const result = await this.handle.pool.query<{ payload_json: string }>(
      `SELECT part.payload_json FROM read_model_snapshot_parts part
      JOIN read_model_snapshots snapshot ON snapshot.id=part.snapshot_id AND snapshot.generation=part.generation
      WHERE part.snapshot_id=$1 AND part.generation=$2 AND part.ordinal=$3`,
      [id, generation, ordinal],
    );
    return result.rows[0] ? (JSON.parse(result.rows[0].payload_json) as unknown) : null;
  }

  async cleanup(before: string, limit: number) {
    await this.handle.ready;
    await this.handle.pool.query(
      `DELETE FROM read_model_snapshots WHERE id IN
      (SELECT id FROM read_model_snapshots WHERE lease_token IS NULL ORDER BY accessed_at DESC,id DESC LIMIT $1 OFFSET 2048)`,
      [limit],
    );
    await this.handle.pool.query(
      `DELETE FROM read_model_snapshots WHERE id IN (SELECT id FROM read_model_snapshots WHERE accessed_at<$1 AND (lease_token IS NULL OR lease_expires_at<$1) LIMIT $2)`,
      [before, limit],
    );
    await this.handle.pool.query(
      `DELETE FROM read_model_snapshot_parts WHERE (snapshot_id,generation,ordinal) IN
      (SELECT part.snapshot_id,part.generation,part.ordinal FROM read_model_snapshot_parts part
       JOIN read_model_snapshots snapshot ON snapshot.id=part.snapshot_id WHERE part.generation<>COALESCE(snapshot.generation,'')
       AND part.generation<>COALESCE(snapshot.lease_token,'') LIMIT $1)`,
      [limit * READ_MODEL_CLEANUP_PARTS_PER_SNAPSHOT],
    );
  }
}
