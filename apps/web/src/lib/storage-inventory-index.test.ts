import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { StorageInventoryItem, StorageInventorySummary } from "@autoforge/contracts";
import { StorageInventoryIndex } from "./storage-inventory-index";

it("retains a superseded snapshot from replacement time so idle single-node pagination can finish", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inventory-generation-"));
  const path = join(directory, "index.sqlite");
  const reader = new StorageInventoryIndex(path);
  const writer = new StorageInventoryIndex(path);
  const startedAt = Date.parse("2026-09-22T00:00:00Z");
  const summary: StorageInventorySummary = {
    generatedAt: new Date(startedAt).toISOString(),
    dataDirectory: directory,
    objectStore: "local",
    objectStoreRoot: join(directory, "objects"),
    fileCount: 2,
    logicalBytes: 2,
    allocatedBytes: 2,
    externalReferenceCount: 0,
    externalReferenceBytes: 0,
    categories: [],
  };
  const items: StorageInventoryItem[] = ["first", "last"].map((name) => ({
    id: name,
    name,
    category: "other",
    location: "data-directory",
    logicalPath: name,
    storagePath: join(directory, name),
    sizeBytes: 1,
    allocatedBytes: 1,
  }));
  function publish(at: number): string {
    const generation = writer.claim(at)!;
    expect(generation).toBeTruthy();
    writer.append(generation, 0, items, at);
    writer.publish(generation, summary, at);
    return generation;
  }
  try {
    const previous = publish(startedAt);
    expect(reader.page(previous, { after: -1, limit: 1 }).nextOrdinal).toBe(0);
    const resumedAt = startedAt + 20 * 60_000;
    publish(resumedAt);
    // Opening an idle page triggers a new snapshot while its next chunk is in flight.
    expect(reader.page(previous, { after: 0, limit: 1 }).items.map((item) => item.name)).toEqual([
      "last",
    ]);
    publish(resumedAt + 5 * 60_000);
    expect(reader.page(previous, { after: 0, limit: 1 }).items).toHaveLength(1);
    const current = publish(resumedAt + 10 * 60_000 + 1);
    expect(() => reader.page(previous, { after: 0, limit: 1 })).toThrow(
      expect.objectContaining({ code: "STORAGE_INVENTORY_SNAPSHOT_EXPIRED" }),
    );
    expect(() => reader.page(previous, { after: 0, limit: 1 })).not.toThrow(/节点/u);
    expect(reader.page(current, { after: -1, limit: 10 }).items).toHaveLength(2);
  } finally {
    reader.close();
    writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
