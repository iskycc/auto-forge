import type {
  ArtifactObjectIdentity,
  ArtifactUploadTarget,
  JarObjectStorePort,
  ObjectWriteResult,
} from "@autoforge/application";
import type { ObjectEntry } from "@autoforge/contracts";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
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

  async putJar(projectId: string, sha256: string, content: Uint8Array): Promise<ObjectWriteResult> {
    validateScopeId(projectId);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Object SHA-256 is invalid.");
    const objectKey = `projects/${projectId}/jars/${sha256.slice(0, 2)}/${sha256}.jar`;
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

  async putObject(input: {
    objectKey: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    content: AsyncIterable<Uint8Array>;
  }): Promise<ObjectWriteResult> {
    validateObjectKey(input.objectKey);
    validateObjectMetadata(input.sha256, input.sizeBytes);
    try {
      const existing = await this.client.statObject(this.bucket, input.objectKey);
      if (existing.size !== input.sizeBytes) throw new Error("Existing object size is invalid.");
      return { objectKey: input.objectKey, created: false };
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
    const digest = createHash("sha256");
    let sizeBytes = 0;
    const verifiedContent = async function* () {
      for await (const chunk of input.content) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > input.sizeBytes) throw new Error("Object exceeds its declared size.");
        digest.update(chunk);
        yield Buffer.from(chunk);
      }
    };
    await this.client.putObject(
      this.bucket,
      input.objectKey,
      Readable.from(verifiedContent()),
      input.sizeBytes,
      { "Content-Type": input.mediaType, "X-Amz-Meta-Sha256": input.sha256 },
    );
    if (sizeBytes !== input.sizeBytes || digest.digest("hex") !== input.sha256) {
      await this.client.removeObject(this.bucket, input.objectKey);
      throw new Error("Object content does not match its declaration.");
    }
    return { objectKey: input.objectKey, created: true };
  }

  async putArtifact(input: {
    projectId: string;
    attemptId: string;
    artifactId: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    content: AsyncIterable<Uint8Array>;
  }): Promise<ObjectWriteResult> {
    validateArtifactIdentity(input.attemptId, input.artifactId, input.sha256, input.sizeBytes);
    const objectKey = artifactObjectKey(input);
    try {
      const existing = await this.client.statObject(this.bucket, objectKey);
      if (existing.size !== input.sizeBytes) throw new Error("Existing artifact size is invalid.");
      return { objectKey, created: false };
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
    const digest = createHash("sha256");
    let sizeBytes = 0;
    const verifiedContent = async function* () {
      for await (const chunk of input.content) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > input.sizeBytes) throw new Error("Artifact exceeds its declared size.");
        digest.update(chunk);
        yield Buffer.from(chunk);
      }
    };
    await this.client.putObject(
      this.bucket,
      objectKey,
      Readable.from(verifiedContent()),
      input.sizeBytes,
      { "Content-Type": input.mediaType, "X-Amz-Meta-Sha256": input.sha256 },
    );
    if (sizeBytes !== input.sizeBytes || digest.digest("hex") !== input.sha256) {
      await this.client.removeObject(this.bucket, objectKey);
      throw new Error("Artifact content does not match its declaration.");
    }
    return { objectKey, created: true };
  }

  async prepareArtifactUpload(input: ArtifactObjectIdentity): Promise<ArtifactUploadTarget> {
    validateArtifactIdentity(input.attemptId, input.artifactId, input.sha256, input.sizeBytes);
    const objectKey = artifactObjectKey(input);
    return {
      kind: "direct",
      objectKey,
      uploadUrl: await this.client.presignedPutObject(this.bucket, objectKey, 15 * 60),
    };
  }

  async verifyArtifactUpload(input: ArtifactObjectIdentity): Promise<ObjectWriteResult> {
    validateArtifactIdentity(input.attemptId, input.artifactId, input.sha256, input.sizeBytes);
    const objectKey = artifactObjectKey(input);
    try {
      const metadata = await this.client.statObject(this.bucket, objectKey);
      if (metadata.size !== input.sizeBytes)
        throw new Error("Artifact size does not match declaration.");
      const stream = await this.client.getObject(this.bucket, objectKey);
      const digest = createHash("sha256");
      let sizeBytes = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += bytes.byteLength;
        if (sizeBytes > input.sizeBytes) throw new Error("Artifact exceeds its declared size.");
        digest.update(bytes);
      }
      if (sizeBytes !== input.sizeBytes || digest.digest("hex") !== input.sha256) {
        throw new Error("Artifact content does not match its declaration.");
      }
      return { objectKey, created: true };
    } catch (error) {
      await this.client.removeObject(this.bucket, objectKey).catch(() => undefined);
      throw error;
    }
  }

  async delete(objectKey: string): Promise<void> {
    validateObjectKey(objectKey);
    await this.client.removeObject(this.bucket, objectKey);
  }

  async exists(objectKey: string): Promise<boolean> {
    validateObjectKey(objectKey);
    try {
      await this.client.statObject(this.bucket, objectKey);
      return true;
    } catch (error) {
      if (isMissingObject(error)) return false;
      throw error;
    }
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

function artifactObjectKey(
  input: Pick<ArtifactObjectIdentity, "projectId" | "attemptId" | "artifactId" | "sha256">,
) {
  validateScopeId(input.projectId);
  return `projects/${input.projectId}/artifacts/${input.attemptId}/${input.artifactId}/${input.sha256}`;
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

function validateArtifactIdentity(
  attemptId: string,
  artifactId: string,
  sha256: string,
  sizeBytes: number,
): void {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (!identifier.test(attemptId) || !identifier.test(artifactId)) {
    throw new Error("Artifact identity is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("Artifact metadata is invalid.");
  }
}

function validateObjectMetadata(sha256: string, sizeBytes: number): void {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("Object metadata is invalid.");
  }
}

function validateScopeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Object project scope is invalid.");
  }
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "NoSuchKey" || code === "NotFound";
}
