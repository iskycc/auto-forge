import type { JarObjectStorePort, ObjectWriteResult } from "@autoforge/application";
import type { ObjectEntry } from "@autoforge/contracts";
import { Client, type BucketItem, type ClientOptions } from "minio";

export type MinioObjectStoreOptions = ClientOptions & {
  bucket: string;
};

export class MinioObjectStore implements JarObjectStorePort {
  readonly storageKind = "minio" as const;
  private readonly client: Client;
  private readonly bucket: string;

  constructor(options: MinioObjectStoreOptions) {
    this.client = new Client(options);
    this.bucket = options.bucket;
  }

  async putJar(sha256: string, content: Uint8Array): Promise<ObjectWriteResult> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Object SHA-256 is invalid.");
    const objectKey = `jars/${sha256.slice(0, 2)}/${sha256}.jar`;
    try {
      await this.client.statObject(this.bucket, objectKey);
      return { objectKey, created: false };
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
    await this.client.putObject(this.bucket, objectKey, Buffer.from(content), content.byteLength, {
      "Content-Type": "application/java-archive",
      "X-Amz-Meta-Sha256": sha256,
    });
    return { objectKey, created: true };
  }

  async delete(objectKey: string): Promise<void> {
    validateObjectKey(objectKey);
    await this.client.removeObject(this.bucket, objectKey);
  }

  async list(input: { cursor?: string; limit: number; prefix?: string }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error("Object list limit must be between 1 and 200.");
    }
    if (input.prefix) validateObjectKey(input.prefix);
    if (input.cursor) validateObjectKey(input.cursor);

    const stream = this.client.listObjectsV2(
      this.bucket,
      input.prefix ?? "",
      true,
      input.cursor ?? "",
    );
    const items: ObjectEntry[] = [];
    for await (const item of stream as unknown as AsyncIterable<BucketItem>) {
      if (!("name" in item) || !item.name || !item.lastModified) continue;
      items.push({
        objectKey: item.name,
        sizeBytes: item.size,
        lastModified: item.lastModified.toISOString(),
        ...(item.etag ? { etag: item.etag } : {}),
      });
      if (items.length > input.limit) break;
    }
    const pageItems = items.slice(0, input.limit);
    const result: { items: ObjectEntry[]; nextCursor?: string } = { items: pageItems };
    const lastItem = pageItems.at(-1);
    if (items.length > input.limit && lastItem) result.nextCursor = lastItem.objectKey;
    return result;
  }

  async read(objectKey: string): Promise<Uint8Array> {
    validateObjectKey(objectKey);
    const stream = await this.client.getObject(this.bucket, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async ready(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket))) {
      throw new Error(`MinIO bucket ${this.bucket} does not exist.`);
    }
  }
}

function validateObjectKey(objectKey: string): void {
  if (
    !objectKey ||
    objectKey.startsWith("/") ||
    objectKey.includes("..") ||
    objectKey.includes("\\")
  ) {
    throw new Error("Object key is invalid.");
  }
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "NoSuchKey" || code === "NotFound";
}
