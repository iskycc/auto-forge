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
    await expect(store.exists(results[0]?.objectKey ?? "missing")).resolves.toBe(true);
    await expect(store.exists("jars/00/missing.jar")).resolves.toBe(false);
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

  it("streams an artifact and rejects a mismatched digest", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-artifacts-"));
    temporaryDirectories.push(directory);
    const content = new TextEncoder().encode("testng report");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const store = new LocalObjectStore(directory);

    await expect(
      store.prepareArtifactUpload({
        attemptId: "attempt-1",
        artifactId: "artifact-1",
        sha256,
        sizeBytes: content.byteLength,
        mediaType: "application/xml",
      }),
    ).resolves.toEqual({ kind: "control-plane" });

    const stored = await store.putArtifact({
      attemptId: "attempt-1",
      artifactId: "artifact-1",
      sha256,
      sizeBytes: content.byteLength,
      mediaType: "application/xml",
      content: chunks(content),
    });
    await expect(store.read(stored.objectKey)).resolves.toEqual(Buffer.from(content));
    await expect(
      store.verifyArtifactUpload({
        attemptId: "attempt-1",
        artifactId: "artifact-1",
        sha256,
        sizeBytes: content.byteLength,
        mediaType: "application/xml",
      }),
    ).resolves.toMatchObject({ objectKey: stored.objectKey });
    await expect(
      store.putArtifact({
        attemptId: "attempt-2",
        artifactId: "artifact-2",
        sha256: "0".repeat(64),
        sizeBytes: content.byteLength,
        mediaType: "application/xml",
        content: chunks(content),
      }),
    ).rejects.toThrow("SHA-256");
  });
});

async function* chunks(content: Uint8Array): AsyncGenerator<Uint8Array> {
  yield content.subarray(0, 3);
  yield content.subarray(3);
}
