import type { RunBatchRepository } from "./ports";

/**
 * 返回 Agent 可以安全删除的本地批次缓存。只有该 Runner 仍被选中且批次尚未
 * 终态时才保留；终态、已删除或不属于该 Runner 的 ID 都不可再用于后续派发。
 */
export async function discardableRunnerBatchCacheIds(
  batches: RunBatchRepository,
  runnerId: string,
  cachedBatchIds: readonly string[],
): Promise<string[]> {
  const uniqueBatchIds = [...new Set(cachedBatchIds)];
  if (uniqueBatchIds.length === 0) return [];
  const reusable = new Set(await batches.listReusableBatchIdsForRunner(runnerId, uniqueBatchIds));
  return uniqueBatchIds.filter((batchId) => !reusable.has(batchId));
}
