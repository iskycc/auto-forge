import type { ReadModelLease, ReadModelSnapshotRepository } from "@autoforge/application";
import type { ReadModelQuery } from "@autoforge/contracts";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { readModelSnapshotFromRow, type ReadModelSnapshotRow } from "./read-model-snapshot-row";

export class PostgresReadModelSnapshotRepository implements ReadModelSnapshotRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async request(id: string, query: ReadModelQuery, now: string) {
    await this.handle.ready;
    await this.handle.pool.query(
      `INSERT INTO read_model_snapshots (id,project_id,query_json,accessed_at,refresh_after)
      VALUES ($1,$2,$3,$4,$4) ON CONFLICT(id) DO UPDATE SET accessed_at=excluded.accessed_at
      WHERE read_model_snapshots.accessed_at<$5`,
      [
        id,
        query.projectId,
        JSON.stringify(query),
        now,
        new Date(Date.parse(now) - 60_000).toISOString(),
      ],
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

  async claim(now: string, expiresAt: string, token: string) {
    await this.handle.ready;
    const result = await this.handle.pool.query<ReadModelSnapshotRow>(
      `UPDATE read_model_snapshots SET lease_token=$1,lease_expires_at=$2
      WHERE id=(SELECT id FROM read_model_snapshots WHERE refresh_after<=$3 AND (lease_expires_at IS NULL OR lease_expires_at<=$3)
      AND failed<5 AND accessed_at>=$4 ORDER BY CASE WHEN generated_at IS NULL THEN 0 ELSE 1 END,refresh_after,id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
      [token, expiresAt, now, new Date(Date.parse(now) - 300_000).toISOString()],
    );
    return result.rows[0] ? { ...readModelSnapshotFromRow(result.rows[0]), token } : null;
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

  async fail(lease: ReadModelLease, retryAt: string) {
    await this.handle.pool.query(
      `UPDATE read_model_snapshots SET failed=CASE WHEN requested_revision=$1 THEN failed+1 ELSE 0 END,refresh_after=CASE WHEN requested_revision=$1 THEN $2 ELSE refresh_after END,
      lease_token=NULL,lease_expires_at=NULL WHERE id=$3 AND lease_token=$4`,
      [lease.requestedRevision, retryAt, lease.id, lease.token],
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
      [limit * 20],
    );
  }
}
