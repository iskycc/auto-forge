const MINIMUM_WORKER_HEAP_MB = 128;
const MAXIMUM_WORKER_HEAP_MB = 4096;
const WORKER_MEMORY_SHARE = 0.4;
const MAINTENANCE_HEAP_WEIGHT = 4;

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
  maintenanceWorkerHeapMb: number;
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
    workerHeapMb: MINIMUM_WORKER_HEAP_MB,
    maintenanceWorkerHeapMb: MINIMUM_WORKER_HEAP_MB,
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
  // A file-maintenance lane and an independent diagnostic reader exist in both modes. Minimal isolation
  // still uses sleeping/I/O threads on tiny hosts; spare CPU scales the busy lanes.
  const minimumThreads = mode === "lite" ? 8 : 7;
  const threadBudget = Math.max(
    minimumThreads,
    Math.min(
      minimumThreads + Math.max(0, Math.floor(resources.cpuCapacity) - 1) * 2,
      Math.floor((memoryMb * WORKER_MEMORY_SHARE) / 192),
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
  // Spreadsheet inflation, cell objects and parsed rows coexist during an import.
  // Weight maintenance heaps instead of raising every thread's limit; the same
  // 40% process budget still leaves room for Web, native buffers and the OS.
  const ordinaryLanes = totalThreads - plan.maintenanceLanes;
  const heapBudgetMb = Math.floor(memoryMb * WORKER_MEMORY_SHARE);
  const maintenanceWeight = Math.max(
    1,
    Math.min(
      MAINTENANCE_HEAP_WEIGHT,
      (heapBudgetMb - ordinaryLanes * MINIMUM_WORKER_HEAP_MB) /
        (plan.maintenanceLanes * MINIMUM_WORKER_HEAP_MB),
    ),
  );
  plan.workerHeapMb = Math.max(
    MINIMUM_WORKER_HEAP_MB,
    Math.min(
      MAXIMUM_WORKER_HEAP_MB,
      Math.floor(heapBudgetMb / (ordinaryLanes + plan.maintenanceLanes * maintenanceWeight)),
    ),
  );
  plan.maintenanceWorkerHeapMb = Math.min(
    MAXIMUM_WORKER_HEAP_MB,
    Math.floor(plan.workerHeapMb * maintenanceWeight),
  );
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
    Math.min(Math.floor(resources.cpuCapacity), Math.floor((memoryMb * WORKER_MEMORY_SHARE) / 256)),
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
      MINIMUM_WORKER_HEAP_MB,
      Math.min(
        MAXIMUM_WORKER_HEAP_MB,
        Math.floor((memoryMb * WORKER_MEMORY_SHARE) / (snapshotLanes + maintenanceLanes)),
      ),
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
