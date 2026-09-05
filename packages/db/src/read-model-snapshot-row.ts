import { readModelQuerySchema } from "@autoforge/contracts";
import type { ReadModelSnapshot } from "@autoforge/application";

export type ReadModelSnapshotRow = {
  id: string;
  query_json: string;
  payload_json: string | null;
  generation: string | null;
  generated_at: string | null;
  refresh_after: string;
  requested_revision: number;
  generated_revision: number;
  failed: number;
};

export function readModelSnapshotFromRow(row: ReadModelSnapshotRow): ReadModelSnapshot {
  return {
    id: row.id,
    query: readModelQuerySchema.parse(JSON.parse(row.query_json)),
    payload: row.payload_json === null ? null : (JSON.parse(row.payload_json) as unknown),
    generation: row.generation,
    generatedAt: row.generated_at,
    refreshAfter: row.refresh_after,
    requestedRevision: row.requested_revision,
    generatedRevision: row.generated_revision,
    failed: row.failed !== 0,
  };
}
