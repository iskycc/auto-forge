import { batchCountersSnapshotSchema, type ReadModelQuery } from "@autoforge/contracts";
import type { RunBatchListQuery, RunBatchRepository } from "./ports";
import type { ReadModelSnapshotService } from "./read-model-snapshots";

const emptyCounters = {
  queuedRuns: 0,
  assignedRuns: 0,
  runningRuns: 0,
  succeededRuns: 0,
  failedRuns: 0,
  timedOutRuns: 0,
  cancelledRuns: 0,
};

/** Paging and control status stay current; cached counters never participate in commands or authorization. */
export async function readBatchPage(
  batches: Pick<RunBatchRepository, "listMetadataPage">,
  snapshots: ReadModelSnapshotService,
  input: RunBatchListQuery,
) {
  const page = await batches.listMetadataPage({
    ...input,
    limit: Math.max(1, Math.min(200, input.limit)),
  });
  const first = page.items[0];
  const query: ReadModelQuery | undefined = first
    ? {
        kind: "batch_counters",
        projectId: first.projectId,
        batches: page.items.map((batch) => ({
          id: batch.id,
          projectId: batch.projectId,
          ...(["succeeded", "failed", "cancelled"].includes(batch.status)
            ? { terminalVersion: batch.version }
            : {}),
        })),
      }
    : undefined;
  const projection = query ? await snapshots.read(query) : null;
  const counters = new Map(
    (projection?.payload ? batchCountersSnapshotSchema.parse(projection.payload) : []).map(
      (counter) => [counter.id, counter],
    ),
  );
  return {
    ...page,
    items: page.items.map((batch) => ({
      ...batch,
      ...(counters.get(batch.id) ?? emptyCounters),
      statisticsPending: !counters.has(batch.id),
    })),
    statistics: projection?.status,
    query,
  };
}
