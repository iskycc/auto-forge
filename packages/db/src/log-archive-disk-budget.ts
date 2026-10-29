import { DomainError } from "@autoforge/domain";
export type ArchiveDiskBudget = { availableBytes: number; reservedBytes: number };
export function archiveDiskBudget(
  disk: { totalBytes: number; availableBytes: number },
  options: { minimumFreeMiB: number; minimumFreePercent: number },
): ArchiveDiskBudget {
  return {
    availableBytes: disk.availableBytes,
    reservedBytes: Math.max(
      options.minimumFreeMiB * 1024 ** 2,
      Math.ceil((disk.totalBytes * options.minimumFreePercent) / 100),
    ),
  };
}
export function estimateArchiveTemporaryBytes(input: {
  sourceBytes: number;
  attemptCount: number;
  viewerBytes: number;
}): number {
  // Frames, ZIP and a local immutable object may coexist. Metadata sorting also uses disk.
  return Math.ceil(
    input.sourceBytes * 3 + input.attemptCount * 4096 + input.viewerBytes * 3 + 64 * 1024 ** 2,
  );
}
export function assertArchiveDiskBudget(budget: ArchiveDiskBudget, additionalBytes: number): void {
  if (budget.availableBytes >= budget.reservedBytes + additionalBytes) return;
  const format = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  throw new DomainError(
    "LOG_ARCHIVE_DISK_FULL",
    `归档临时空间不足：可用 ${format(budget.availableBytes)}，平台安全余量 ${format(budget.reservedBytes)}，本卷预计还需 ${format(additionalBytes)}。请释放空间或扩容后重试；要减小分卷目标，请取消本卷再重新发起。单个执行批次保持完整，原日志不会清理。`,
  );
}
