import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

import { open } from "node:fs/promises";

import { stageRuntimeArchive } from "./runtime-archive-upload";

describe("stageRuntimeArchive", () => {
  let testRoot: string;
  let stagingRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "autoforge-runtime-upload-test-"));
    stagingRoot = join(testRoot, "upload-staging");
  });

  afterEach(async () => {
    vi.mocked(open).mockClear();
    await rm(testRoot, { force: true, recursive: true });
  });

  it("streams a raw archive while calculating its integrity metadata", async () => {
    const request = archiveRequest([0x50, 0x4b, 0x03, 0x04]);

    const staged = await stageRuntimeArchive(request, "zip", stagingRoot);
    try {
      expect(staged.fileName).toBe("依赖包.zip");
      expect(staged.sizeBytes).toBe(4);
      expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const chunks: Uint8Array[] = [];
      for await (const chunk of staged.content) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    } finally {
      await staged.dispose();
    }
  });

  it("creates the staging directory under the provided root and removes it on dispose", async () => {
    const request = archiveRequest([0x50, 0x4b, 0x03, 0x04]);

    const staged = await stageRuntimeArchive(request, "zip", stagingRoot);
    const entries = await readdir(stagingRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^autoforge-runtime-upload-/u);

    await staged.dispose();
    await expect(readdir(stagingRoot)).resolves.toEqual([]);
  });

  it("rejects a mismatched extension or archive signature", async () => {
    const request = new Request("http://localhost/runtime-assets/upload", {
      method: "POST",
      headers: { "x-autoforge-file-name": "dependencies.tar.gz" },
      body: new Uint8Array([0x50, 0x4b]),
    });

    await expect(stageRuntimeArchive(request, "tar.gz", stagingRoot)).rejects.toMatchObject({
      code: "RUNTIME_ASSET_FORMAT_INVALID",
    });
  });

  it("maps ENOSPC staging failures to a storage domain error and cleans up", async () => {
    const cause = Object.assign(new Error("ENOSPC: no space left on device, open"), {
      code: "ENOSPC",
    });
    vi.mocked(open).mockRejectedValueOnce(cause);
    const request = archiveRequest([0x50, 0x4b, 0x03, 0x04]);

    const failure = await stageRuntimeArchive(request, "zip", stagingRoot).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "RUNTIME_ASSET_STORAGE_FULL", cause });
    await expect(readdir(stagingRoot)).resolves.toEqual([]);
  });
});

function archiveRequest(bytes: number[]): Request {
  const content = new Uint8Array(bytes);
  return new Request("http://localhost/runtime-assets/upload", {
    method: "POST",
    headers: {
      "content-length": String(content.byteLength),
      "x-autoforge-file-name": encodeURIComponent("依赖包.zip"),
    },
    body: content,
  });
}
