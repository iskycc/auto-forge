import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, link, mkdir, open, opendir, readFile, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type { JarObjectStorePort, ObjectWriteResult } from "@autoforge/application";

export class LocalObjectStore implements JarObjectStorePort {
  readonly storageKind = "local" as const;
  private readonly objectsDirectory: string;

  constructor(dataDirectory: string) {
    this.objectsDirectory = resolve(dataDirectory, "objects");
  }

  async putJar(projectId: string, sha256: string, content: Uint8Array): Promise<ObjectWriteResult> {
    validateScopeId(projectId);
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error("Object SHA-256 is invalid.");
    }
    const objectKey = `projects/${projectId}/jars/${sha256.slice(0, 2)}/${sha256}.jar`;
    const targetPath = this.resolveObjectKey(objectKey);
    await mkdir(dirname(targetPath), { recursive: true });
    if (await this.pathExists(targetPath)) {
      return { objectKey, created: false };
    }

    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }

    try {
      // A hard link publishes the fully-synced temporary file atomically without
      // replacing an object created concurrently by another import.
      await link(temporaryPath, targetPath);
      return { objectKey, created: true };
    } catch (error) {
      if (await this.pathExists(targetPath)) {
        return { objectKey, created: false };
      }
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async putObject(input: {
    objectKey: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    content: AsyncIterable<Uint8Array>;
  }): Promise<ObjectWriteResult> {
    validateObjectMetadata(input.objectKey, input.sha256, input.sizeBytes);
    const targetPath = this.resolveObjectKey(input.objectKey);
    await mkdir(dirname(targetPath), { recursive: true });
    if (await this.pathExists(targetPath)) {
      await this.verifyStoredObject(targetPath, input.sizeBytes, input.sha256);
      return { objectKey: input.objectKey, created: false };
    }
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    const digest = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const chunk of input.content) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > input.sizeBytes) throw new Error("Object exceeds its declared size.");
        digest.update(chunk);
        await writeCompleteChunk(file, chunk);
      }
      await file.sync();
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      await file.close();
    }
    try {
      if (sizeBytes !== input.sizeBytes || digest.digest("hex") !== input.sha256) {
        throw new Error("Object content does not match its declaration.");
      }
      await link(temporaryPath, targetPath);
      return { objectKey: input.objectKey, created: true };
    } catch (error) {
      if (await this.pathExists(targetPath)) {
        await this.verifyStoredObject(targetPath, input.sizeBytes, input.sha256);
        return { objectKey: input.objectKey, created: false };
      }
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async delete(objectKey: string): Promise<void> {
    await rm(this.resolveObjectKey(objectKey), { force: true });
  }

  async exists(objectKey: string): Promise<boolean> {
    return this.pathExists(this.resolveObjectKey(objectKey));
  }

  async list(input: { cursor?: string; limit: number; prefix?: string }) {
    this.assertListInput(input);
    const items = [];
    for await (const filePath of this.walk(this.objectsDirectory)) {
      const objectKey = relative(this.objectsDirectory, filePath).split(sep).join("/");
      if (input.cursor && objectKey <= input.cursor) continue;
      if (input.prefix && !objectKey.startsWith(input.prefix)) continue;
      const metadata = await stat(filePath);
      items.push({
        objectKey,
        sizeBytes: metadata.size,
        lastModified: metadata.mtime.toISOString(),
      });
      if (items.length > input.limit) break;
    }
    const pageItems = items.slice(0, input.limit);
    const result: {
      items: typeof pageItems;
      nextCursor?: string;
    } = { items: pageItems };
    const lastItem = pageItems.at(-1);
    if (items.length > input.limit && lastItem) result.nextCursor = lastItem.objectKey;
    return result;
  }

  async openRead(objectKey: string) {
    const file = await open(this.resolveObjectKey(objectKey), "r");
    try {
      const metadata = await file.stat();
      return { sizeBytes: metadata.size, content: file.createReadStream() };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async readRange(objectKey: string, offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 16 * 1024 * 1024
    )
      throw new Error("Invalid object read range.");
    const file = await open(this.resolveObjectKey(objectKey), "r");
    try {
      const metadata = await file.stat();
      if (offset + length > metadata.size) throw new Error("Object range exceeds stored size.");
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const result = await file.read(buffer, filled, length - filled, offset + filled);
        if (!result.bytesRead) throw new Error("Incomplete object range.");
        filled += result.bytesRead;
      }
      return buffer;
    } finally {
      await file.close();
    }
  }

  async read(objectKey: string): Promise<Uint8Array> {
    return readFile(this.resolveObjectKey(objectKey));
  }

  async ready(): Promise<void> {
    await mkdir(this.objectsDirectory, { recursive: true });
    await access(this.objectsDirectory, constants.R_OK | constants.W_OK);
  }

  private async verifyStoredObject(
    targetPath: string,
    expectedSizeBytes: number,
    expectedSha256: string,
  ): Promise<void> {
    const metadata = await stat(targetPath);
    if (metadata.size !== expectedSizeBytes) throw new Error("Existing object size is invalid.");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(targetPath)) digest.update(chunk);
    if (digest.digest("hex") !== expectedSha256) {
      throw new Error("Existing object SHA-256 is invalid.");
    }
  }

  private resolveObjectKey(objectKey: string): string {
    if (objectKey.startsWith("/") || objectKey.includes("..") || objectKey.includes("\\")) {
      throw new Error("Object key is invalid.");
    }
    const target = resolve(this.objectsDirectory, objectKey);
    if (!target.startsWith(`${this.objectsDirectory}${sep}`)) {
      throw new Error("Object key escapes the object directory.");
    }
    return target;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private assertListInput(input: { limit: number; prefix?: string }): void {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new Error("Object list limit must be between 1 and 200.");
    }
    if (input.prefix) this.resolveObjectKey(input.prefix);
  }

  private async *walk(directory: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const sorted = [];
    for await (const entry of entries) sorted.push(entry);
    sorted.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of sorted) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) yield* this.walk(path);
      if (entry.isFile()) yield path;
    }
  }
}

async function writeCompleteChunk(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten === 0) throw new Error("Object storage write made no progress.");
    offset += bytesWritten;
  }
}

function validateObjectMetadata(objectKey: string, sha256: string, sizeBytes: number): void {
  if (
    !objectKey ||
    objectKey.startsWith("/") ||
    objectKey.includes("..") ||
    objectKey.includes("\\")
  ) {
    throw new Error("Object key is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("Object metadata is invalid.");
  }
}

function validateScopeId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Object project scope is invalid.");
  }
}
