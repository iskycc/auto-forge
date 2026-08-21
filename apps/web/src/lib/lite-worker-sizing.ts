export function liteWorkerLaneCount(cpuCount: number, backgroundConcurrency: number): number {
  const usableCpuCount = Math.max(1, Math.trunc(cpuCount) - 1);
  return Math.max(1, Math.min(4, usableCpuCount, Math.max(1, backgroundConcurrency)));
}
