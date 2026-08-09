import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalObjectStore } from "../src/local-object-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalObjectStore", () => {
  it("publishes one immutable object for concurrent writes of the same JAR", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-objects-"));
    temporaryDirectories.push(directory);
    const content = new TextEncoder().encode("fixture jar content");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const store = new LocalObjectStore(directory);

    const results = await Promise.all([
      store.putJar(sha256, content),
      store.putJar(sha256, content),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.objectKey))).toEqual(
      new Set([`jars/${sha256.slice(0, 2)}/${sha256}.jar`]),
    );
    await expect(
      readFile(resolve(directory, "objects", results[0]?.objectKey ?? "missing")),
    ).resolves.toEqual(Buffer.from(content));

    const page = await store.list({ limit: 20, prefix: "jars/" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      objectKey: `jars/${sha256.slice(0, 2)}/${sha256}.jar`,
      sizeBytes: content.byteLength,
    });
    await expect(store.read(page.items[0]?.objectKey ?? "missing")).resolves.toEqual(
      Buffer.from(content),
    );
  });
});
