import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, link, mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { JarObjectStorePort, ObjectWriteResult } from "@autoforge/application";

export class LocalObjectStore implements JarObjectStorePort {
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
    } catch {
      return false;
    }
  }
}
