import type { StorageInventoryItem, StorageInventorySummary } from "@autoforge/contracts";
import { describe, expect, it } from "vitest";

import { removeRuntimeAssetsFromInventory } from "./storage-inventory-deletion";

describe("storage inventory deletion patch", () => {
  it("removes uploaded and external assets while updating every affected summary field", () => {
    const uploaded = item({
      id: "local:asset-a",
      runtimeAssetId: "asset-a",
      category: "jdk",
      sizeBytes: 100,
      allocatedBytes: 128,
    });
    const external = item({
      id: "external:asset-b",
      runtimeAssetId: "asset-b",
      category: "dependency",
      location: "external-reference",
      sizeBytes: 200,
      allocatedBytes: 0,
    });
    const retained = item({ id: "local:database", category: "database", sizeBytes: 50 });
    const summary: StorageInventorySummary = {
      generatedAt: "2026-09-04T00:00:00.000Z",
      dataDirectory: "/data",
      objectStore: "local",
      objectStoreRoot: "/data/objects",
      fileCount: 3,
      logicalBytes: 350,
      allocatedBytes: 178,
      externalReferenceCount: 1,
      externalReferenceBytes: 200,
      categories: [
        { category: "jdk", fileCount: 1, logicalBytes: 100, allocatedBytes: 128 },
        { category: "dependency", fileCount: 1, logicalBytes: 200, allocatedBytes: 0 },
        { category: "database", fileCount: 1, logicalBytes: 50, allocatedBytes: 50 },
      ],
    };

    const patched = removeRuntimeAssetsFromInventory(
      [uploaded, external, retained],
      summary,
      new Set(["asset-a", "asset-b"]),
    );

    expect(patched.items).toEqual([retained]);
    expect(patched.removedItems).toEqual([uploaded, external]);
    expect(patched.summary).toMatchObject({
      fileCount: 1,
      logicalBytes: 50,
      allocatedBytes: 50,
      externalReferenceCount: 0,
      externalReferenceBytes: 0,
      categories: [{ category: "database", fileCount: 1, logicalBytes: 50, allocatedBytes: 50 }],
    });
  });
});

function item(overrides: Partial<StorageInventoryItem>): StorageInventoryItem {
  return {
    id: "local:item",
    category: "other",
    location: "data-directory",
    name: "item.bin",
    logicalPath: "item.bin",
    storagePath: "/data/item.bin",
    sizeBytes: 0,
    allocatedBytes: overrides.sizeBytes ?? 0,
    ...overrides,
  };
}
