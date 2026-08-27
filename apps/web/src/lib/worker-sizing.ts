/**
 * 执行工作线程的车道数：保留一枚核给 Web 事件循环，车道数随可用核数与
 * 后台并发上限增长，封顶 4 条，避免线程本身成为 CPU 竞争源。
 */
export function workerLaneCount(cpuCount: number, backgroundConcurrency: number): number {
  const usableCpuCount = Math.max(1, Math.trunc(cpuCount) - 1);
  return Math.max(1, Math.min(4, usableCpuCount, Math.max(1, backgroundConcurrency)));
}
