import type { StorageInventoryItem } from "@autoforge/contracts";
import { describe, expect, it } from "vitest";

import {
  buildStorageInventoryTree,
  type StorageDirectoryNode,
} from "./storage-inventory-tree-model";

describe("storage inventory tree model", () => {
  it("groups files by storage location and directory while aggregating directory totals", () => {
    const tree = buildStorageInventoryTree(
      [
        item({
          id: "local:db/main.sqlite",
          logicalPath: "db/main.sqlite",
          sizeBytes: 10,
          allocatedBytes: 16,
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-02T00:00:00.000Z",
          runBatchId: "batch-main",
        }),
        item({
          id: "local:db/main.sqlite-wal",
          logicalPath: "db/main.sqlite-wal",
          sizeBytes: 4,
          allocatedBytes: 8,
          modifiedAt: "2026-09-02T01:00:00.000Z",
        }),
        item({
          id: "local:db/main.sqlite-shm",
          logicalPath: "db/main.sqlite-shm",
          sizeBytes: 2,
          allocatedBytes: 8,
          modifiedAt: "2026-09-02T02:00:00.000Z",
        }),
        item({
          id: "object:projects/p1/runtime-assets/jdk.zip",
          location: "object-store",
          logicalPath: "projects/p1/runtime-assets/jdk.zip",
          storagePath: "minio://autoforge/projects/p1/runtime-assets/jdk.zip",
          sizeBytes: 20,
          allocatedBytes: 20,
        }),
      ],
      { dataDirectory: "/data", objectStoreRoot: "minio://autoforge" },
    );

    expect(tree.map((root) => root.name)).toEqual(["数据目录", "对象存储"]);
    expect(tree[0]).toMatchObject({
      storagePath: "/data",
      fileCount: 3,
      sizeBytes: 16,
      allocatedBytes: 32,
    });
    expect(tree[0]?.directories[0]).toMatchObject({
      name: "db",
      fileCount: 3,
      files: [
        expect.objectContaining({
          kind: "sqlite-group",
          sizeBytes: 16,
          allocatedBytes: 32,
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-02T02:00:00.000Z",
          primary: expect.objectContaining({ name: "main.sqlite", runBatchId: "batch-main" }),
          physicalFiles: [
            expect.objectContaining({ name: "main.sqlite" }),
            expect.objectContaining({ name: "main.sqlite-wal" }),
            expect.objectContaining({ name: "main.sqlite-shm" }),
          ],
        }),
      ],
    });
    expect(directoryIds(tree, 1)).toEqual(
      new Set([
        "storage-location:data-directory",
        "storage-location:data-directory:db",
        "storage-location:object-store",
        "storage-location:object-store:projects",
      ]),
    );
  });

  it("caps pathological logical path depth without losing the file or full source path", () => {
    const logicalPath = `${Array.from({ length: 40 }, (_, index) => `d${index}`).join("/")}/file.zip`;
    const tree = buildStorageInventoryTree([item({ logicalPath })], {
      dataDirectory: "/data",
      objectStoreRoot: "/data/objects",
    });
    let directory: StorageDirectoryNode = tree[0]!;
    let directoryDepth = 0;
    while (directory.directories[0]) {
      directory = directory.directories[0];
      directoryDepth += 1;
    }

    expect(directoryDepth).toBe(16);
    expect(directory.files[0]?.primary.logicalPath).toBe(logicalPath);
    expect(directory.name).toContain("/");
  });

  it("groups SQLite companions even when a companion is received before its main file", () => {
    const tree = buildStorageInventoryTree(
      [
        item({ logicalPath: "db/reordered.sqlite-wal", sizeBytes: 3 }),
        item({ logicalPath: "db/reordered.sqlite", sizeBytes: 5 }),
      ],
      { dataDirectory: "/data", objectStoreRoot: "/data/objects" },
    );

    expect(tree[0]?.directories[0]?.files).toEqual([
      expect.objectContaining({
        kind: "sqlite-group",
        sizeBytes: 8,
        physicalFiles: [
          expect.objectContaining({ logicalPath: "db/reordered.sqlite" }),
          expect.objectContaining({ logicalPath: "db/reordered.sqlite-wal" }),
        ],
      }),
    ]);
  });
});

function item(overrides: Partial<StorageInventoryItem>): StorageInventoryItem {
  const logicalPath = overrides.logicalPath ?? "db/main.sqlite";
  return {
    id: overrides.id ?? `local:${logicalPath}`,
    category: "database",
    location: "data-directory",
    name: logicalPath.split("/").at(-1)!,
    logicalPath,
    storagePath: `/data/${logicalPath}`,
    sizeBytes: 1,
    allocatedBytes: 1,
    modifiedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function directoryIds(roots: readonly StorageDirectoryNode[], maximumDepth: number): Set<string> {
  const ids = new Set<string>();
  function collect(directory: StorageDirectoryNode): void {
    if (directory.depth <= maximumDepth) ids.add(directory.id);
    for (const child of directory.directories) collect(child);
  }
  for (const root of roots) collect(root);
  return ids;
}
