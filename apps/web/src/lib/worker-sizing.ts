/**
 * 执行工作线程的车道数：保留一枚核给 Web 事件循环，车道数随可用核数与
 * 后台并发上限增长，封顶 4 条，避免线程本身成为 CPU 竞争源。
 */
export function workerLaneCount(cpuCount: number, backgroundConcurrency: number): number {
  const usableCpuCount = Math.max(1, Math.trunc(cpuCount) - 1);
  return Math.max(1, Math.min(4, usableCpuCount, Math.max(1, backgroundConcurrency)));
}

/**
 * Full 只在线程池中执行补位调度，不复制 Lite 的独立日志车道。车道数同时受
 * PostgreSQL 连接预算约束，保证每条车道至少能拥有一个连接。
 */
export function fullWorkerLaneCount(
  cpuCount: number,
  backgroundConcurrency: number,
  databasePoolMax: number,
): number {
  return Math.min(
    2,
    Math.max(1, databasePoolMax),
    workerLaneCount(cpuCount, backgroundConcurrency),
  );
}

/** 把 Full 调度线程的总连接预算均分到各车道，避免每个线程重复使用整池上限。 */
export function fullWorkerPoolMaxPerLane(databasePoolMax: number, laneCount: number): number {
  return Math.max(1, Math.floor(Math.max(1, databasePoolMax) / Math.max(1, laneCount)));
}
