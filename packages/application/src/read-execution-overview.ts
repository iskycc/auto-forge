import { executionOverviewSnapshotSchema, type ReadModelStatus } from "@autoforge/contracts";
import { DomainError, summarizeRunBatchCounters } from "@autoforge/domain";
import type { RunBatchDetailOverview, RunBatchRepository } from "./ports";
import type { ReadModelSnapshotService } from "./read-model-snapshots";

export type CachedExecutionOverview = RunBatchDetailOverview & { statistics: ReadModelStatus };

/** Control status reads current metadata; result counters and charts are explicitly timestamped background statistics. */
export async function readExecutionOverview(
  batches: Pick<RunBatchRepository, "getMetadata">,
  snapshots: ReadModelSnapshotService,
  batchId: string,
  projectIds?: readonly string[],
): Promise<CachedExecutionOverview> {
  const metadata = await batches.getMetadata(batchId, projectIds);
  if (!metadata || metadata.kind === "case_log_rerun")
    throw new DomainError("RUN_BATCH_NOT_FOUND", "执行批次不存在或当前身份无权访问。");
  const terminal = ["succeeded", "failed", "cancelled"].includes(metadata.status);
  const projection = await snapshots.read({
    kind: "execution_overview",
    projectId: metadata.projectId,
    batchId,
    ...(terminal ? { terminalVersion: metadata.version } : {}),
  });
  const statistics = projection.payload
    ? executionOverviewSnapshotSchema.parse(projection.payload)
    : null;
  const batch = {
    ...metadata,
    ...(statistics?.counters ?? {
      queuedRuns: 0,
      assignedRuns: 0,
      runningRuns: 0,
      succeededRuns: 0,
      failedRuns: 0,
      timedOutRuns: 0,
      cancelledRuns: 0,
    }),
  };
  const finalSummary = summarizeRunBatchCounters(batch);
  return {
    batch,
    roundSummaries: statistics?.roundSummaries ?? [],
    allRoundsSummary: statistics?.allRoundsSummary ?? finalSummary,
    finalSummary,
    roundRecoveries: (statistics?.roundRecoveries ??
      []) as RunBatchDetailOverview["roundRecoveries"],
    roundConcurrencies: (statistics?.roundConcurrencies ??
      []) as RunBatchDetailOverview["roundConcurrencies"],
    runnerRoundSummaries: statistics?.runnerRoundSummaries ?? [],
    runnerFaultIncidents: statistics?.runnerFaultIncidents ?? [],
    participatingRunnerIds: statistics?.participatingRunnerIds ?? [],
    finishedAt: statistics?.finishedAt ?? batch.updatedAt,
    statistics: projection.status,
  };
}
