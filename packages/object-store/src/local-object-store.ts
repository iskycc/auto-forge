import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, link, mkdir, open, opendir, readFile, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type { JarObjectStorePort, ObjectWriteResult } from "@autoforge/application";

export class LocalObjectStore implements JarObjectStorePort {
  readonly storageKind = "local" as const;
  private readonly objectsDirectory: string;

  constructor(dataDirectory: string) {
    this.objectsDirectory = resolve(dataDirectory, "objects");
  }

  async putJar(sha256: string, content: Uint8Array): Promise<ObjectWriteResult> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error("Object SHA-256 is invalid.");
    }
    const objectKey = `jars/${sha256.slice(0, 2)}/${sha256}.jar`;
    const targetPath = this.resolveObjectKey(objectKey);
    await mkdir(dirname(targetPath), { recursive: true });
    if (await this.exists(targetPath)) {
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
      if (await this.exists(targetPath)) {
        return { objectKey, created: false };
      }
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async delete(objectKey: string): Promise<void> {
    await rm(this.resolveObjectKey(objectKey), { force: true });
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

  async read(objectKey: string): Promise<Uint8Array> {
    return readFile(this.resolveObjectKey(objectKey));
  }

  async ready(): Promise<void> {
    await mkdir(this.objectsDirectory, { recursive: true });
    await access(this.objectsDirectory, constants.R_OK | constants.W_OK);
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

  private async exists(filePath: string): Promise<boolean> {
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
