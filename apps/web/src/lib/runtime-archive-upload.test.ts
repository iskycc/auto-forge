import { describe, expect, it } from "vitest";

import { stageRuntimeArchive } from "./runtime-archive-upload";

describe("stageRuntimeArchive", () => {
  it("streams a raw archive while calculating its integrity metadata", async () => {
    const content = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const request = new Request("http://localhost/runtime-assets/upload", {
      method: "POST",
      headers: {
        "content-length": String(content.byteLength),
        "x-autoforge-file-name": encodeURIComponent("依赖包.zip"),
      },
      body: content,
    });

    const staged = await stageRuntimeArchive(request, "zip");
    try {
      expect(staged.fileName).toBe("依赖包.zip");
      expect(staged.sizeBytes).toBe(content.byteLength);
      expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const chunks: Uint8Array[] = [];
      for await (const chunk of staged.content) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(content));
    } finally {
      await staged.dispose();
    }
  });

  it("rejects a mismatched extension or archive signature", async () => {
    const content = new Uint8Array([0x50, 0x4b]);
    const request = new Request("http://localhost/runtime-assets/upload", {
      method: "POST",
      headers: { "x-autoforge-file-name": "dependencies.tar.gz" },
      body: content,
    });

    await expect(stageRuntimeArchive(request, "tar.gz")).rejects.toMatchObject({
      code: "RUNTIME_ASSET_FORMAT_INVALID",
    });
  });
});
