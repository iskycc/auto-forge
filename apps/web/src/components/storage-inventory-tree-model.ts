import type { StorageInventoryItem, StorageInventoryLocation } from "@autoforge/contracts";

const MAXIMUM_DIRECTORY_DEPTH = 16;

export type StorageDirectoryNode = {
  id: string;
  kind: "directory";
  name: string;
  logicalPath: string;
  depth: number;
  fileCount: number;
  sizeBytes: number;
  allocatedBytes: number;
  directories: StorageDirectoryNode[];
  files: StorageInventoryItem[];
};

export type StorageLocationNode = StorageDirectoryNode & {
  location: StorageInventoryLocation;
  storagePath: string;
};

type MutableDirectoryNode = Omit<StorageDirectoryNode, "directories"> & {
  directories: Map<string, MutableDirectoryNode>;
};

const LOCATION_ORDER: StorageInventoryLocation[] = [
  "data-directory",
  "object-store",
  "external-reference",
];

export function buildStorageInventoryTree(
  items: readonly StorageInventoryItem[],
  roots: {
    dataDirectory: string;
    objectStoreRoot: string;
  },
): StorageLocationNode[] {
  const locationRoots = new Map<StorageInventoryLocation, MutableDirectoryNode>();
  for (const item of items) {
    const root =
      locationRoots.get(item.location) ??
      createDirectory(`storage-location:${item.location}`, locationLabel(item.location), "", 0);
    locationRoots.set(item.location, root);
    accumulate(root, item);
    let current = root;
    let logicalPath = "";
    for (const directoryName of directorySegments(item.logicalPath)) {
      logicalPath = logicalPath ? `${logicalPath}/${directoryName}` : directoryName;
      const child =
        current.directories.get(directoryName) ??
        createDirectory(`${root.id}:${logicalPath}`, directoryName, logicalPath, current.depth + 1);
      current.directories.set(directoryName, child);
      accumulate(child, item);
      current = child;
    }
    current.files.push(item);
  }

  return LOCATION_ORDER.flatMap((location) => {
    const root = locationRoots.get(location);
    if (!root) return [];
    return [
      {
        ...finalizeDirectory(root),
        location,
        storagePath: locationRootPath(location, roots),
      },
    ];
  });
}

function createDirectory(
  id: string,
  name: string,
  logicalPath: string,
  depth: number,
): MutableDirectoryNode {
  return {
    id,
    kind: "directory",
    name,
    logicalPath,
    depth,
    fileCount: 0,
    sizeBytes: 0,
    allocatedBytes: 0,
    directories: new Map(),
    files: [],
  };
}

function accumulate(directory: MutableDirectoryNode, item: StorageInventoryItem): void {
  directory.fileCount += 1;
  directory.sizeBytes += item.sizeBytes;
  directory.allocatedBytes += item.allocatedBytes;
}

function finalizeDirectory(directory: MutableDirectoryNode): StorageDirectoryNode {
  return {
    ...directory,
    directories: [...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
      .map(finalizeDirectory),
    files: directory.files
      .slice()
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id),
      ),
  };
}

function directorySegments(logicalPath: string): string[] {
  const segments = logicalPath.split("/").filter(Boolean);
  if (segments.length <= 1) return [];
  const directories = segments.slice(0, -1);
  if (directories.length <= MAXIMUM_DIRECTORY_DEPTH) return directories;
  return [
    ...directories.slice(0, MAXIMUM_DIRECTORY_DEPTH - 1),
    directories.slice(MAXIMUM_DIRECTORY_DEPTH - 1).join("/"),
  ];
}

function locationLabel(location: StorageInventoryLocation): string {
  switch (location) {
    case "data-directory":
      return "数据目录";
    case "object-store":
      return "对象存储";
    case "external-reference":
      return "外部引用";
  }
}

function locationRootPath(
  location: StorageInventoryLocation,
  roots: { dataDirectory: string; objectStoreRoot: string },
): string {
  switch (location) {
    case "data-directory":
      return roots.dataDirectory;
    case "object-store":
      return roots.objectStoreRoot;
    case "external-reference":
      return "外部 URL 引用（不占用平台空间）";
  }
}
