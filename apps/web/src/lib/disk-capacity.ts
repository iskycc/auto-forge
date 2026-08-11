import { statfs } from "node:fs/promises";

export type DiskCapacity = {
  capacityBytes: number;
  availableBytes: number;
  usedPercent: number;
  status: "ok" | "warning" | "critical";
};

export async function readDiskCapacity(path: string): Promise<DiskCapacity> {
  const statistics = await statfs(path, { bigint: true });
  const capacityBytes = statistics.bsize * statistics.blocks;
  const availableBytes = statistics.bsize * statistics.bavail;
  if (capacityBytes <= 0n) throw new Error("数据卷未报告有效容量。");
  const usedBasisPoints = Number(((capacityBytes - availableBytes) * 10_000n) / capacityBytes);
  const usedPercent = Math.round(usedBasisPoints) / 100;
  return {
    capacityBytes: safeByteCount(capacityBytes),
    availableBytes: safeByteCount(availableBytes),
    usedPercent,
    status: diskCapacityStatus(usedPercent),
  };
}

export function diskCapacityStatus(usedPercent: number): DiskCapacity["status"] {
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw new Error("磁盘使用率必须在 0 到 100 之间。");
  }
  if (usedPercent >= 95) return "critical";
  if (usedPercent >= 85) return "warning";
  return "ok";
}

function safeByteCount(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("数据卷容量超过当前诊断协议可表达范围。");
  }
  return Number(value);
}
