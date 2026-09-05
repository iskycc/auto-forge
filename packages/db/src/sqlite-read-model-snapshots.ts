import type { ReadModelLease, ReadModelSnapshotRepository } from "@autoforge/application";
import type { ReadModelQuery } from "@autoforge/contracts";
import { retrySqliteLockContention, type SqliteDatabaseHandle } from "./database";
import { readModelSnapshotFromRow, type ReadModelSnapshotRow } from "./read-model-snapshot-row";

export class SqliteReadModelSnapshotRepository implements ReadModelSnapshotRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async request(id: string, query: ReadModelQuery, now: string) {
    await retrySqliteLockContention(() =>
      this.handle.client
        .prepare(
          `INSERT INTO read_model_snapshots
      (id,project_id,query_json,accessed_at,refresh_after) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET accessed_at=excluded.accessed_at
      WHERE read_model_snapshots.accessed_at<?`,
        )
        .run(
          id,
          query.projectId,
          JSON.stringify(query),
          now,
          now,
          new Date(Date.parse(now) - 60_000).toISOString(),
        ),
    );
    const snapshot = await this.get(id);
    if (!snapshot) throw new Error(`Read model ${id} disappeared after registration.`);
    return snapshot;
  }

  async get(id: string) {
    const row = this.handle.client
      .prepare("SELECT * FROM read_model_snapshots WHERE id=?")
      .get(id) as ReadModelSnapshotRow | undefined;
    return row ? readModelSnapshotFromRow(row) : null;
  }

  async claim(now: string, expiresAt: string, token: string) {
    const row = await retrySqliteLockContention(
      () =>
        this.handle.client
          .prepare(
            `UPDATE read_model_snapshots
      SET lease_token=?,lease_expires_at=? WHERE id=(SELECT id FROM read_model_snapshots
      WHERE refresh_after<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)
      AND failed<5 AND accessed_at>=? ORDER BY CASE WHEN generated_at IS NULL THEN 0 ELSE 1 END,refresh_after,id LIMIT 1)
      RETURNING *`,
          )
          .get(token, expiresAt, now, now, new Date(Date.parse(now) - 300_000).toISOString()) as
          ReadModelSnapshotRow | undefined,
    );
    return row ? { ...readModelSnapshotFromRow(row), token } : null;
  }

  async renew(lease: ReadModelLease, now: string, expiresAt: string) {
    return (
      (
        await retrySqliteLockContention(() =>
          this.handle.client
            .prepare(
              `UPDATE read_model_snapshots SET lease_expires_at=?
      WHERE id=? AND lease_token=? AND requested_revision=? AND lease_expires_at>?`,
            )
            .run(expiresAt, lease.id, lease.token, lease.requestedRevision, now),
        )
      ).changes > 0
    );
  }

  async complete(
    lease: ReadModelLease,
    payload: unknown,
    generatedAt: string,
    refreshAfter: string,
  ) {
    return retrySqliteLockContention(() =>
      this.handle.client.transaction(() => {
        const saved =
          this.handle.client
            .prepare(
              `UPDATE read_model_snapshots SET payload_json=?,generation=?,generated_at=?,
        refresh_after=?,generated_revision=?,lease_token=NULL,lease_expires_at=NULL,failed=0
        WHERE id=? AND lease_token=? AND requested_revision=? AND lease_expires_at>?`,
            )
            .run(
              JSON.stringify(payload),
              lease.token,
              generatedAt,
              refreshAfter,
              lease.requestedRevision,
              lease.id,
              lease.token,
              lease.requestedRevision,
              generatedAt,
            ).changes > 0;
        if (!saved)
          this.handle.client
            .prepare(
              "UPDATE read_model_snapshots SET lease_token=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=?",
            )
            .run(lease.id, lease.token);
        return saved;
      })(),
    );
  }

  async fail(lease: ReadModelLease, retryAt: string) {
    await retrySqliteLockContention(() =>
      this.handle.client
        .prepare(
          `UPDATE read_model_snapshots
      SET failed=CASE WHEN requested_revision=? THEN failed+1 ELSE 0 END,refresh_after=CASE WHEN requested_revision=? THEN ? ELSE refresh_after END,lease_token=NULL,lease_expires_at=NULL
      WHERE id=? AND lease_token=?`,
        )
        .run(lease.requestedRevision, lease.requestedRevision, retryAt, lease.id, lease.token),
    );
  }

  async invalidate(projectId: string, now: string) {
    await retrySqliteLockContention(() =>
      this.handle.client
        .prepare(
          `UPDATE read_model_snapshots SET requested_revision=requested_revision+1,failed=0,refresh_after=? WHERE project_id=?`,
        )
        .run(now, projectId),
    );
  }

  async putPart(lease: ReadModelLease, ordinal: number, payload: unknown) {
    await retrySqliteLockContention(() =>
      this.handle.client
        .prepare(
          `INSERT INTO read_model_snapshot_parts (snapshot_id,generation,ordinal,payload_json)
      VALUES (?,?,?,?) ON CONFLICT(snapshot_id,generation,ordinal) DO UPDATE SET payload_json=excluded.payload_json`,
        )
        .run(lease.id, lease.token, ordinal, JSON.stringify(payload)),
    );
  }

  async getPart(id: string, generation: string, ordinal: number) {
    const row = this.handle.client
      .prepare(
        `SELECT part.payload_json FROM read_model_snapshot_parts part
      JOIN read_model_snapshots snapshot ON snapshot.id=part.snapshot_id AND snapshot.generation=part.generation
      WHERE part.snapshot_id=? AND part.generation=? AND part.ordinal=?`,
      )
      .get(id, generation, ordinal) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as unknown) : null;
  }

  async cleanup(before: string, limit: number) {
    await retrySqliteLockContention(() =>
      this.handle.client
        .prepare(
          `DELETE FROM read_model_snapshots WHERE id IN
      (SELECT id FROM read_model_snapshots WHERE lease_token IS NULL ORDER BY accessed_at DESC,id DESC LIMIT ? OFFSET 2048)`,
        )
        .run(limit),
    );
    await retrySqliteLockContention(() =>
      this.handle.client
        .prepare(
          `DELETE FROM read_model_snapshots WHERE id IN
      (SELECT id FROM read_model_snapshots WHERE accessed_at<? AND (lease_token IS NULL OR lease_expires_at<?) LIMIT ?)`,
        )
        .run(before, before, limit),
    );
    await retrySqliteLockContention(() =>
      this.handle.client
        .prepare(
          `DELETE FROM read_model_snapshot_parts WHERE rowid IN
      (SELECT part.rowid FROM read_model_snapshot_parts part JOIN read_model_snapshots snapshot ON snapshot.id=part.snapshot_id
       WHERE part.generation<>COALESCE(snapshot.generation,'') AND part.generation<>COALESCE(snapshot.lease_token,'') LIMIT ?)`,
        )
        .run(limit * 20),
    );
  }
}
