import { createHash, randomUUID } from "node:crypto";

import { Client } from "minio";
import { describe, expect, it } from "vitest";

import { MinioObjectStore } from "../src/minio-object-store";

const endpoint = process.env.AUTOFORGE_TEST_MINIO_ENDPOINT;
const accessKey = process.env.AUTOFORGE_TEST_MINIO_ACCESS_KEY;
const secretKey = process.env.AUTOFORGE_TEST_MINIO_SECRET_KEY;

describe.skipIf(!endpoint || !accessKey || !secretKey)("MinioObjectStore", () => {
  it("writes, lists, reads and deletes an immutable JAR", async () => {
    const url = new URL(endpoint!);
    const bucket = `autoforge-${randomUUID()}`;
    const options = {
      endPoint: url.hostname,
      port: Number(url.port),
      useSSL: url.protocol === "https:",
      accessKey: accessKey!,
      secretKey: secretKey!,
      bucket,
    };
    const client = new Client(options);
    await client.makeBucket(bucket);
    const store = new MinioObjectStore(options);
    const content = new TextEncoder().encode("minio fixture");
    const sha256 = createHash("sha256").update(content).digest("hex");
    try {
      await expect(store.ready()).resolves.toBeUndefined();
      const written = await store.putJar(sha256, content);
      expect(written.created).toBe(true);
      expect((await store.list({ limit: 10, prefix: "jars/" })).items).toHaveLength(1);
      await expect(store.read(written.objectKey)).resolves.toEqual(Buffer.from(content));
      await store.delete(written.objectKey);
    } finally {
      await client.removeBucket(bucket);
    }
  });
});
