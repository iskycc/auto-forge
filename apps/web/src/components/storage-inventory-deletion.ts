import type { StorageInventoryItem, StorageInventorySummary } from "@autoforge/contracts";

export type StorageInventoryDeletionPatch = {
  items: StorageInventoryItem[];
  summary: StorageInventorySummary;
  removedItems: StorageInventoryItem[];
};

/**
 * 删除成功后直接修补客户端已有的完整清单，避免再次扫描整个数据目录与对象存储。
 * 调用方只允许在清单加载完成后执行删除，因此这里可以用实际条目的逻辑/占用大小
 * 精确修正汇总数据，包括不占平台磁盘的外部引用。
 */
export function removeRuntimeAssetsFromInventory(
  items: readonly StorageInventoryItem[],
  summary: StorageInventorySummary,
  runtimeAssetIds: ReadonlySet<string>,
): StorageInventoryDeletionPatch {
  const removedItems = items.filter(
    (item) => item.runtimeAssetId && runtimeAssetIds.has(item.runtimeAssetId),
  );
  if (removedItems.length === 0) {
    return { items: [...items], summary, removedItems: [] };
  }

  const removedItemIds = new Set(removedItems.map((item) => item.id));
  const categoryDeltas = new Map<
    StorageInventoryItem["category"],
    { fileCount: number; logicalBytes: number; allocatedBytes: number }
  >();
  let logicalBytes = 0;
  let allocatedBytes = 0;
  let externalReferenceCount = 0;
  let externalReferenceBytes = 0;

  for (const item of removedItems) {
    logicalBytes += item.sizeBytes;
    allocatedBytes += item.allocatedBytes;
    if (item.location === "external-reference") {
      externalReferenceCount += 1;
      externalReferenceBytes += item.sizeBytes;
    }
    const delta = categoryDeltas.get(item.category) ?? {
      fileCount: 0,
      logicalBytes: 0,
      allocatedBytes: 0,
    };
    delta.fileCount += 1;
    delta.logicalBytes += item.sizeBytes;
    delta.allocatedBytes += item.allocatedBytes;
    categoryDeltas.set(item.category, delta);
  }

  return {
    items: items.filter((item) => !removedItemIds.has(item.id)),
    removedItems,
    summary: {
      ...summary,
      fileCount: subtract(summary.fileCount, removedItems.length),
      logicalBytes: subtract(summary.logicalBytes, logicalBytes),
      allocatedBytes: subtract(summary.allocatedBytes, allocatedBytes),
      externalReferenceCount: subtract(summary.externalReferenceCount, externalReferenceCount),
      externalReferenceBytes: subtract(summary.externalReferenceBytes, externalReferenceBytes),
      categories: summary.categories.flatMap((category) => {
        const delta = categoryDeltas.get(category.category);
        if (!delta) return [category];
        const next = {
          ...category,
          fileCount: subtract(category.fileCount, delta.fileCount),
          logicalBytes: subtract(category.logicalBytes, delta.logicalBytes),
          allocatedBytes: subtract(category.allocatedBytes, delta.allocatedBytes),
        };
        return next.fileCount === 0 ? [] : [next];
      }),
    },
  };
}

function subtract(current: number, removed: number): number {
  return Math.max(0, current - removed);
}
