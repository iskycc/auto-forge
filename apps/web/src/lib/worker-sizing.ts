export type WebResourcePlan = {
  cpuCapacity: number;
  memoryCapacityBytes: number;
  schedulingLanes: number;
  controlLanes: number;
  uploadLanes: number;
  logReadLanes: number;
  logWriteLanes: number;
  snapshotLanes: number;
  maintenanceLanes: number;
  workerHeapMb: number;
  foregroundCapacity: number;
};

/** One budget covers all pools, so each pool cannot independently allocate every CPU. */
export function webResourcePlan(
  resources: { cpuCapacity: number; memoryCapacityBytes: number },
  mode: "lite" | "full",
  databasePoolMax = 1,
): WebResourcePlan {
  const memoryMb = Math.floor(resources.memoryCapacityBytes / 1024 ** 2);
  const plan: WebResourcePlan = {
    ...resources,
    schedulingLanes: 1,
    controlLanes: mode === "lite" ? 1 : 0,
    uploadLanes: mode === "lite" ? 1 : 0,
    logReadLanes: 1,
    logWriteLanes: mode === "full" ? 1 : 0,
    snapshotLanes: 1,
    maintenanceLanes: 1,
    workerHeapMb: 128,
    foregroundCapacity: 2,
  };
  const roles =
    mode === "lite"
      ? ([
          "uploadLanes",
          "controlLanes",
          "schedulingLanes",
          "logReadLanes",
          "snapshotLanes",
          "maintenanceLanes",
        ] as const)
      : ([
          "logWriteLanes",
          "schedulingLanes",
          "logReadLanes",
          "logWriteLanes",
          "snapshotLanes",
          "maintenanceLanes",
        ] as const);
  // One additional file-maintenance lane exists in both modes. Minimal isolation
  // still uses sleeping/I/O threads on tiny hosts; spare CPU scales the busy lanes.
  const minimumThreads = mode === "lite" ? 7 : 6;
  const threadBudget = Math.max(
    minimumThreads,
    Math.min(
      minimumThreads + Math.max(0, Math.floor(resources.cpuCapacity) - 1) * 2,
      Math.floor((memoryMb * 0.4) / 192),
    ),
  );
  let totalThreads = minimumThreads;
  let cursor = 0;
  while (totalThreads < threadBudget) {
    const role = roles[cursor++ % roles.length]!;
    if (role === "schedulingLanes" && mode === "full" && plan[role] >= databasePoolMax) continue;
    plan[role]++;
    totalThreads++;
  }
  // Leave 60% for Web, native buffers, SQLite page cache, other processes and the OS.
  plan.workerHeapMb = Math.max(128, Math.min(4096, Math.floor((memoryMb * 0.4) / totalThreads)));
  plan.foregroundCapacity = Math.max(
    2,
    (plan.schedulingLanes + plan.controlLanes + plan.uploadLanes + plan.logWriteLanes) * 2,
  );
  return plan;
}

export function stableLaneIndex(value: string, laneCount: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % laneCount;
}

/** Standalone Full processes share one CPU/memory budget across imports and snapshots. */
export function backgroundResourcePlan(
  resources: { cpuCapacity: number; memoryCapacityBytes: number },
  concurrency: number,
  databasePoolMax: number,
) {
  const memoryMb = Math.floor(resources.memoryCapacityBytes / 1024 ** 2);
  const budget = Math.max(
    2,
    Math.min(Math.floor(resources.cpuCapacity), Math.floor((memoryMb * 0.4) / 256)),
  );
  const snapshotLanes = Math.max(1, Math.floor(budget / 4));
  const maintenanceLanes = Math.max(
    1,
    Math.min(concurrency, databasePoolMax, budget - snapshotLanes),
  );
  return {
    snapshotLanes,
    maintenanceLanes,
    workerHeapMb: Math.max(
      128,
      Math.min(4096, Math.floor((memoryMb * 0.4) / (snapshotLanes + maintenanceLanes))),
    ),
  };
}

/** 把 Full 调度线程的总连接预算均分到各车道，避免每个线程重复使用整池上限。 */
export function fullWorkerPoolMaxPerLane(
  databasePoolMax: number,
  laneCount: number,
  laneIndex = 0,
): number {
  const count = Math.max(1, laneCount);
  const budget = Math.max(1, databasePoolMax);
  return Math.max(1, Math.floor(budget / count) + Number(laneIndex < budget % count));
}
