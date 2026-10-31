import { runBatchCountersSchema } from "@autoforge/contracts";
import { isTerminalRunBatchStatus, type RunBatch } from "@autoforge/domain";
import { sql } from "drizzle-orm";

export const HISTORY_SNAPSHOT_VERSION = 1;

export function historySnapshotWrite(batch: RunBatch) {
  if (!isTerminalRunBatchStatus(batch.status)) return null;
  const counters = JSON.stringify(runBatchCountersSchema.parse(batch));
  // Guard against termination/late reports racing the projection builder.
  return sql`INSERT INTO run_batch_history_snapshots(batch_id,batch_version,snapshot_version,counters_json,created_at)
    SELECT id,version,${HISTORY_SNAPSHOT_VERSION},${counters},${batch.updatedAt} FROM run_batches
    WHERE id=${batch.id} AND version=${batch.version} AND status=${batch.status}
    ON CONFLICT(batch_id) DO UPDATE SET batch_version=excluded.batch_version,
      snapshot_version=excluded.snapshot_version,counters_json=excluded.counters_json,created_at=excluded.created_at`;
}
