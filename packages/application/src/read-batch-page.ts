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
  batches: Pick<
    RunBatchRepository,
    "listMetadataPage" | "readSingleCaseExecutionEntries" | "readHistorySnapshots"
  >,
  snapshots: ReadModelSnapshotService,
  input: RunBatchListQuery,
) {
  const page = await batches.listMetadataPage({
    ...input,
    limit: Math.max(1, Math.min(200, input.limit)),
  });
  const first = page.items[0];
  if (input.executionKind === "single") {
    const singleCases = await batches.readSingleCaseExecutionEntries(
      page.items.map((batch) => batch.id),
    );
    const byBatch = new Map(singleCases.map((entry) => [entry.batchId, entry]));
    const counterKeys = {
      queued: "queuedRuns",
      assigned: "assignedRuns",
      running: "runningRuns",
      succeeded: "succeededRuns",
      failed: "failedRuns",
      timed_out: "timedOutRuns",
      cancelled: "cancelledRuns",
    } as const;
    return {
      ...page,
      items: page.items.map((batch) => {
        const singleCase = byBatch.get(batch.id);
        return {
          ...batch,
          ...emptyCounters,
          ...(singleCase ? { [counterKeys[singleCase.status]]: 1 } : {}),
          singleCase,
          statisticsPending: !singleCase,
        };
      }),
      statistics: undefined,
      query: undefined,
    };
  }
  const history = await batches.readHistorySnapshots(
    page.items.filter((batch) => ["succeeded", "failed", "cancelled"].includes(batch.status)),
  );
  const saved = new Map(history.map((counter) => [counter.id, counter]));
  const unresolved = page.items.filter((batch) => !saved.has(batch.id));
  const query: ReadModelQuery | undefined =
    first && unresolved.length
      ? {
          kind: "batch_counters",
          snapshotVersion: 3,
          projectId: first.projectId,
          batches: unresolved.map((batch) => ({
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
      ...(saved.get(batch.id) ?? counters.get(batch.id) ?? emptyCounters),
      statisticsPending: !saved.has(batch.id) && !counters.has(batch.id),
      singleCase: undefined,
    })),
    statistics: projection?.status,
    query,
  };
}
