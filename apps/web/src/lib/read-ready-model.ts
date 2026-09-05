import { setTimeout as delay } from "node:timers/promises";
import type { ReadModelSnapshotService } from "@autoforge/application";
import type { ReadModelQuery } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

/** Compatibility for JSON readers: wait only for a cold or explicitly invalidated background result. */
export async function readReadySnapshot(
  service: ReadModelSnapshotService,
  query: ReadModelQuery,
  signal: AbortSignal,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (signal.aborted) throw new DomainError("READ_MODEL_REQUEST_CANCELLED", "数据读取已取消。");
    const snapshot = await service.read(query);
    if (snapshot.generation && snapshot.synchronized) return snapshot;
    if (snapshot.state === "failed") break;
    await delay(100, undefined, { signal }).catch((error) => {
      if (signal.aborted) throw new DomainError("READ_MODEL_REQUEST_CANCELLED", "数据读取已取消。");
      throw error;
    });
  }
  throw new DomainError("READ_MODEL_PENDING", "后台正在准备数据，请稍后重试。");
}

export async function readReadyModel(
  service: ReadModelSnapshotService,
  query: ReadModelQuery,
  signal: AbortSignal,
) {
  return (await readReadySnapshot(service, query, signal)).payload;
}
