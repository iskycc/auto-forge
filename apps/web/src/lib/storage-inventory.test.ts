import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { JarObjectStorePort, ProjectStructureService } from "@autoforge/application";
import type { ProjectRuntimeAsset } from "@autoforge/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StorageInventoryService } from "./storage-inventory";

const temporaryDirectories: string[] = [];
const inventories: StorageInventoryService[] = [];

afterEach(async () => {
  await Promise.all(inventories.splice(0).map((inventory) => inventory.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("storage inventory", () => {
  it("returns a cold page before a slow scan finishes, reuses the durable index and fences invalidated scans", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await writeDataFile(dataDirectory, "file.txt", "saved");
    const listing = vi.fn(async () => ({
      items: [
        {
          objectKey: "projects/p/jars/example.jar",
          sizeBytes: 4,
          lastModified: "2026-09-01T00:00:00.000Z",
        },
      ],
    }));
    const store = { ...objectStore("minio", []), list: listing };
    const options = {
      dataDirectory,
      objectStore: store,
      projectStructures: runtimeCatalog([]),
      runBatchDisplayIdentities: batchDisplayIdentities({}),
      objectStoreRoot: "minio://test",
    };
    const inventory = new StorageInventoryService(options);
    inventories.push(inventory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    listing.mockImplementationOnce(async () => {
      await gate;
      return { items: [] };
    });
    try {
      const cold = await inventory.list({ limit: 1 });
      expect(cold).toMatchObject({ snapshotState: "pending", items: [] });
      await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(1));
      // A second HTTP read does not await, duplicate or restart the in-flight scan.
      expect(await inventory.list({ limit: 1 })).toMatchObject({ snapshotState: "pending" });
      inventory.invalidateSummary();
      release();
      await inventory.refresh();
      expect(await inventory.list({ limit: 1 })).toMatchObject({ snapshotState: "pending" });
      await inventory.refresh();
      const published = await inventory.list({ limit: 1 });
      expect(published).toMatchObject({ snapshotState: "ready", summary: { fileCount: 2 } });
      expect(published.nextCursor).toBeTruthy();
      const scans = listing.mock.calls.length;
      for (let index = 0; index < 20; index++)
        expect((await inventory.list({ limit: 1 })).generation).toBe(published.generation);
      expect(listing).toHaveBeenCalledTimes(scans);
      await inventory.close();
      inventories.splice(inventories.indexOf(inventory), 1);
      const restarted = new StorageInventoryService(options);
      inventories.push(restarted);
      expect((await restarted.list({ limit: 1 })).generation).toBe(published.generation);
      expect(listing).toHaveBeenCalledTimes(scans);
      const last = await restarted.list({ limit: 1, cursor: published.nextCursor! });
      expect(last.items).toHaveLength(1);
      const another = new StorageInventoryService({
        ...options,
        dataDirectory: await temporaryDataDirectory(),
      });
      inventories.push(another);
      await expect(another.list({ limit: 1, cursor: published.nextCursor! })).rejects.toMatchObject(
        { code: "READ_MODEL_GENERATION_CONFLICT" },
      );
    } finally {
      release();
    }
  });

  it("keeps a failed refresh observable and recovers the previous generation on explicit retry", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const listing = vi.fn(async () => ({ items: [] }));
    const inventory = new StorageInventoryService({
      dataDirectory,
      objectStore: { ...objectStore("minio", []), list: listing },
      projectStructures: runtimeCatalog([]),
      runBatchDisplayIdentities: batchDisplayIdentities({}),
      objectStoreRoot: "minio://test",
    });
    inventories.push(inventory);
    await inventory.refresh();
    const saved = await inventory.list({ limit: 10 });
    listing.mockRejectedValueOnce(new Error("fixture storage unavailable"));
    inventory.invalidateSummary();
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await inventory.refresh();
      expect(await inventory.list({ limit: 10 })).toMatchObject({
        generation: saved.generation,
        snapshotState: "failed",
      });
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringContaining("fixture storage unavailable"),
      );
      inventory.invalidateSummary();
      await inventory.refresh();
      expect((await inventory.list({ limit: 10 })).snapshotState).toBe("ready");
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("keeps the previous result usable during refresh and preserves paths containing wildcard characters", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await writeDataFile(dataDirectory, "100%.txt", "one");
    await writeDataFile(dataDirectory, "1000.txt", "two");
    const inventory = new StorageInventoryService({
      dataDirectory,
      objectStore: objectStore("local", []),
      projectStructures: runtimeCatalog([]),
      runBatchDisplayIdentities: batchDisplayIdentities({}),
      objectStoreRoot: dataDirectory,
    });
    inventories.push(inventory);
    await inventory.refresh();
    const previous = await inventory.list({ limit: 1 });
    const refreshing = await inventory.list({ limit: 1, refresh: true });
    expect(refreshing).toMatchObject({ generation: previous.generation, snapshotState: "stale" });
    await inventory.refresh();
    expect(
      (await inventory.list({ limit: 50, query: "%" })).items.map((item) => item.name),
    ).toEqual(["100%.txt"]);
    expect((await inventory.list({ limit: 50 })).generation).not.toBe(previous.generation);
    expect((await inventory.list({ limit: 1, cursor: previous.nextCursor! })).items).toHaveLength(
      1,
    );
  });

  it("lists every Lite SQLite and managed file while distinguishing runtime assets", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const jdkObjectKey = "projects/project-1/runtime-assets/jdk-1.zip";
    await writeDataFile(dataDirectory, "db/autoforge.sqlite", "database");
    await writeDataFile(dataDirectory, "db/autoforge.sqlite-wal", "wal");
    await writeDataFile(dataDirectory, "attempt-logs/batch-1.sqlite", "logs");
    await writeDataFile(dataDirectory, `objects/${jdkObjectKey}`, "jdk");
    await writeDataFile(
      dataDirectory,
      `objects/projects/project-1/jars/aa/${"a".repeat(64)}.jar`,
      "jar",
    );
    await writeDataFile(dataDirectory, "config/platform.json", "{}");
    const runtimeAssets = [
      runtimeAsset({ id: "jdk-1", kind: "jdk", sourceType: "upload", objectKey: jdkObjectKey }),
      runtimeAsset({
        id: "dependency-url",
        kind: "jar-bundle",
        sourceType: "url",
        url: "https://assets.example.test/dependencies.zip?credential=hidden",
      }),
    ];
    const inventory = new StorageInventoryService({
      dataDirectory,
      objectStore: objectStore("local", []),
      projectStructures: runtimeCatalog(runtimeAssets),
      runBatchDisplayIdentities: batchDisplayIdentities({ "batch-1": 42 }),
      objectStoreRoot: join(dataDirectory, "objects"),
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });

    inventories.push(inventory);
    await inventory.refresh();
    const items = await allItems(inventory, 2);

    expect(items.map((item) => item.category)).toEqual(
      expect.arrayContaining([
        "database",
        "execution-log",
        "jdk",
        "dependency",
        "case-source",
        "configuration",
      ]),
    );
    expect(items.filter((item) => item.category === "database")).toHaveLength(2);
    expect(items.find((item) => item.logicalPath === "db/autoforge.sqlite")).toMatchObject({
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      modifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
    expect(items.find((item) => item.logicalPath === "attempt-logs/batch-1.sqlite")).toMatchObject({
      category: "execution-log",
      runBatchId: "batch-1",
      runBatchSequenceNumber: 42,
    });
    expect(items.find((item) => item.category === "jdk")).toMatchObject({
      name: "jdk-1.zip",
      logicalPath: `objects/${jdkObjectKey}`,
      location: "data-directory",
      runtimeAssetId: "jdk-1",
    });
    expect(items.find((item) => item.category === "dependency")).toMatchObject({
      allocatedBytes: 0,
      location: "external-reference",
      runtimeAssetId: "dependency-url",
      storagePath: "https://assets.example.test/dependencies.zip?[查询参数已隐藏]",
    });
    const firstPage = await inventory.list({ limit: 2 });
    expect(firstPage.summary).toMatchObject({
      dataDirectory: resolve(dataDirectory),
      objectStore: "local",
      fileCount: 7,
      externalReferenceCount: 1,
      externalReferenceBytes: 1024,
    });
    expect(firstPage.summary.allocatedBytes).toBeGreaterThan(0);
  });

  it("combines Full local log SQLite files, MinIO objects and URL references", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await writeDataFile(dataDirectory, "attempt-logs/batch-full.sqlite", "logs");
    const dependencyKey = "projects/project-2/runtime-assets/dependency-2.tar.gz";
    const objects = [
      {
        objectKey: dependencyKey,
        sizeBytes: 4096,
        lastModified: "2026-09-01T00:00:00.000Z",
      },
      {
        objectKey: `projects/project-2/artifacts/attempt-1/artifact-1/${"b".repeat(64)}`,
        sizeBytes: 512,
        lastModified: "2026-09-01T00:01:00.000Z",
      },
    ];
    const runtimeAssets = [
      runtimeAsset({
        id: "dependency-2",
        projectId: "project-2",
        kind: "jar-bundle",
        sourceType: "upload",
        objectKey: dependencyKey,
      }),
      runtimeAsset({
        id: "jdk-url",
        projectId: "project-2",
        kind: "jdk",
        sourceType: "url",
        url: "https://assets.example.test/jdk.tar.gz",
      }),
    ];
    const inventory = new StorageInventoryService({
      dataDirectory,
      objectStore: objectStore("minio", objects),
      projectStructures: runtimeCatalog(runtimeAssets),
      runBatchDisplayIdentities: batchDisplayIdentities({ "batch-full": 73 }),
      objectStoreRoot: "minio://autoforge",
    });

    inventories.push(inventory);
    await inventory.refresh();
    const page = await inventory.list({ limit: 100 });

    expect(page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "execution-log",
          location: "data-directory",
          runBatchId: "batch-full",
          runBatchSequenceNumber: 73,
        }),
        expect.objectContaining({
          category: "dependency",
          location: "object-store",
          storagePath: `minio://autoforge/${dependencyKey}`,
          allocatedBytes: 4096,
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-01T00:00:00.000Z",
          runtimeAssetId: "dependency-2",
        }),
        expect.objectContaining({ category: "artifact", location: "object-store" }),
        expect.objectContaining({
          category: "jdk",
          location: "external-reference",
          allocatedBytes: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-01T00:00:00.000Z",
          runtimeAssetId: "jdk-url",
        }),
      ]),
    );
    expect(page.summary).toMatchObject({
      objectStore: "minio",
      objectStoreRoot: "minio://autoforge",
      fileCount: 4,
      externalReferenceCount: 1,
    });
  });

  it("resumes a local directory walk without skipping a sibling that shares its prefix", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await writeDataFile(dataDirectory, "a/inside.txt", "inside");
    await writeDataFile(dataDirectory, "a.txt", "sibling");
    await writeDataFile(dataDirectory, "b/final.txt", "final");
    const inventory = new StorageInventoryService({
      dataDirectory,
      objectStore: objectStore("local", []),
      projectStructures: runtimeCatalog([]),
      runBatchDisplayIdentities: batchDisplayIdentities({}),
      objectStoreRoot: join(dataDirectory, "objects"),
    });

    inventories.push(inventory);
    await inventory.refresh();
    const items = await allItems(inventory, 1);

    expect(items.map((item) => item.logicalPath)).toEqual(["a/inside.txt", "a.txt", "b/final.txt"]);
    await expect(inventory.list({ limit: 500 })).resolves.toMatchObject({
      items: expect.any(Array),
    });
    await expect(inventory.list({ limit: 501 })).rejects.toThrow(
      "存储清单单次读取数量必须在 1 到 500 之间",
    );
  });
});

async function temporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-storage-inventory-"));
  temporaryDirectories.push(directory);
  return directory;
}

function batchDisplayIdentities(sequenceNumbers: Readonly<Record<string, number>>) {
  return {
    async listDisplayIdentities(batchIds: readonly string[]) {
      return [...new Set(batchIds)].flatMap((id) => {
        const sequenceNumber = sequenceNumbers[id];
        return sequenceNumber ? [{ id, sequenceNumber }] : [];
      });
    },
  };
}

async function writeDataFile(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, content);
}

function runtimeAsset(
  overrides: Partial<ProjectRuntimeAsset> & Pick<ProjectRuntimeAsset, "id" | "kind" | "sourceType">,
): ProjectRuntimeAsset {
  return {
    projectId: "project-1",
    fileName: `${overrides.id}.${overrides.kind === "jdk" ? "zip" : "tar.gz"}`,
    sha256: "c".repeat(64),
    sizeBytes: 1024,
    archiveFormat: overrides.kind === "jdk" ? "zip" : "tar.gz",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function runtimeCatalog(assets: ProjectRuntimeAsset[]) {
  return {
    async findRuntimeAssetsByObjectKeys(objectKeys: readonly string[]) {
      return assets.filter((asset) => asset.objectKey && objectKeys.includes(asset.objectKey));
    },
    async listRuntimeAssetsPage(input: {
      sourceType?: "upload" | "url";
      afterId?: string;
      limit: number;
    }) {
      const matching = assets
        .filter((asset) => !input.sourceType || asset.sourceType === input.sourceType)
        .filter((asset) => !input.afterId || asset.id > input.afterId)
        .sort((left, right) => left.id.localeCompare(right.id));
      const items = matching.slice(0, input.limit);
      return {
        items,
        ...(matching.length > input.limit && items.at(-1) ? { nextCursor: items.at(-1)!.id } : {}),
      };
    },
  } satisfies Pick<
    ProjectStructureService,
    "listRuntimeAssetsPage" | "findRuntimeAssetsByObjectKeys"
  >;
}

function objectStore(
  storageKind: "local" | "minio",
  objects: Array<{ objectKey: string; sizeBytes: number; lastModified: string }>,
): JarObjectStorePort {
  return {
    storageKind,
    async list(input) {
      const matching = objects.filter((object) => !input.cursor || object.objectKey > input.cursor);
      const items = matching.slice(0, input.limit);
      return {
        items,
        ...(matching.length > input.limit && items.at(-1)
          ? { nextCursor: items.at(-1)!.objectKey }
          : {}),
      };
    },
  } as JarObjectStorePort;
}

async function allItems(inventory: StorageInventoryService, limit: number) {
  const items = [];
  let cursor: string | undefined;
  do {
    const page = await inventory.list({ limit, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
