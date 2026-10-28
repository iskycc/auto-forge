import type { Runner, RunnerResourceSnapshot } from "@autoforge/domain";

type DiskCapacity = NonNullable<RunnerResourceSnapshot["disk"]>;
export const RUNNER_DISK_WARNING_PERCENT = 20;

export function diskAvailablePercent(disk: DiskCapacity | undefined): number | undefined {
  if (
    !disk ||
    disk.totalBytes <= 0 ||
    disk.availableBytes < 0 ||
    disk.availableBytes > disk.totalBytes
  )
    return undefined;
  return (disk.availableBytes / disk.totalBytes) * 100;
}

export function isRunnerDiskLow(disk: DiskCapacity | undefined): boolean {
  const percent = diskAvailablePercent(disk);
  return percent !== undefined && percent < RUNNER_DISK_WARNING_PERCENT;
}

export function isRunnerDiskStale(
  state: Runner["state"],
  observedAt: string,
  now: string,
): boolean {
  return state === "offline" || Date.parse(now) - Date.parse(observedAt) > 90_000;
}

export function formatDiskBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GiB`;
}

export function formatDiskPercent(disk: DiskCapacity): string {
  // Truncate so 19.999% never looks like the non-warning 20% boundary.
  const percent = diskAvailablePercent(disk);
  return percent === undefined ? "未知" : `${Math.floor(percent * 100) / 100}%`;
}
