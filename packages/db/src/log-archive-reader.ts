import { createHash } from "node:crypto";
import {
  logArchiveObjectIndexSchema as indexSchema,
  logArchiveCatalogSchema as catalogSchema,
} from "@autoforge/contracts";
import { DomainError, isDomainError } from "@autoforge/domain";
import type { JarObjectStorePort, ArchivedBatchLocation } from "@autoforge/application";
import type {
  LogArchiveAttempt,
  LogArchiveCatalogFrame,
  LogArchiveObjectIndex,
} from "@autoforge/contracts";
import type { AttemptLogStore, AttemptLogItem } from "./attempt-log-store";
import { decodeArchiveFrame, type ArchivedLogChunk } from "./log-archive-codec";
import { readAttemptLogPage } from "./attempt-log-pagination";
type CachedArchive = {
  index: LogArchiveObjectIndex;
  catalogs: Map<string, LogArchiveCatalogFrame[]>;
};
export class LogArchiveReader {
  private readonly archives = new Map<string, CachedArchive>();
  constructor(private readonly objects: JarObjectStorePort) {}
  async list(location: ArchivedBatchLocation, input: Parameters<AttemptLogStore["listChunks"]>[0]) {
    try {
      const archive = await this.archive(location);
      const prefix = `batches/${input.batchId}/`;
      let catalog = archive.catalogs.get(input.batchId);
      if (!catalog) {
        catalog = catalogSchema.parse(
          JSON.parse(
            (
              await this.file(
                location,
                archive.index,
                `${prefix}catalog.index.json`,
                32 * 1024 * 1024,
              )
            ).toString("utf8"),
          ),
        );
        if (archive.catalogs.size >= 4)
          archive.catalogs.delete(archive.catalogs.keys().next().value!);
        archive.catalogs.set(input.batchId, catalog);
      }
      let left = 0,
        right = catalog.length;
      while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (catalog[middle]!.lastId < input.attemptId) left = middle + 1;
        else right = middle;
      }
      const page = catalog[left];
      if (!page || page.firstId > input.attemptId)
        throw new Error("Archived attempt is missing from catalog.");
      const attempts = decodeArchiveFrame<LogArchiveAttempt>(
        await this.range(
          location,
          archive.index,
          `${prefix}catalog.aflog`,
          page.offset,
          page.length,
        ),
      );
      const attempt = attempts.find((item) => item.id === input.attemptId);
      if (!attempt) throw new Error("Archived attempt metadata is missing.");
      const stream = attempt.streams[input.stream];
      if (!stream) throw new Error("Archived log stream is missing.");
      const descriptor = (number: number) =>
        this.range(
          location,
          archive.index,
          `${prefix}frames.bin`,
          stream.indexOffset + number * 32,
          32,
        );
      return await readAttemptLogPage(input, async (after, limit) => {
        let low = 0,
          high = stream.frameCount;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          const frame = await descriptor(middle);
          if (Number(frame.readBigUInt64LE(16)) <= after) low = middle + 1;
          else high = middle;
        }
        const items: AttemptLogItem[] = [];
        for (let number = low; number < stream.frameCount; number++) {
          const frame = await descriptor(number);
          const rows = decodeArchiveFrame<ArchivedLogChunk>(
            await this.range(
              location,
              archive.index,
              `${prefix}logs.aflog`,
              Number(frame.readBigUInt64LE()),
              frame.readUInt32LE(24),
            ),
          );
          for (const item of rows) {
            if (
              item.attemptId !== input.attemptId ||
              item.frameIndex !== number ||
              item.stream !== input.stream
            )
              throw new Error("Archived frame does not match its attempt, stream or ordinal.");
            if (item.sequence <= after) continue;
            if (input.recordedAfter && item.recordedAt < input.recordedAfter) continue;
            if (input.recordedBefore && item.recordedAt > input.recordedBefore) continue;
            items.push({
              stream: item.stream,
              sequence: item.sequence,
              content: item.content,
              recordedAt: item.recordedAt,
            });
            if (items.length === limit) return items;
          }
        }
        return items;
      });
    } catch (cause) {
      if (isDomainError(cause)) throw cause;
      throw new DomainError(
        "LOG_ARCHIVE_UNAVAILABLE",
        "已归档日志读取失败，请检查归档文件及其索引是否完整；原日志链接不会改读其他数据。",
        { cause },
      );
    }
  }
  async acknowledgedSequence(
    location: ArchivedBatchLocation,
    batchId: string,
    attemptId: string,
    stream: "stdout" | "stderr" | "agent",
  ) {
    const archive = await this.archive(location);
    const prefix = `batches/${batchId}/`;
    const catalog = catalogSchema.parse(
      JSON.parse(
        (
          await this.file(location, archive.index, `${prefix}catalog.index.json`, 32 * 1024 * 1024)
        ).toString("utf8"),
      ),
    );
    const page = catalog.find((page) => page.firstId <= attemptId && page.lastId >= attemptId);
    if (!page) throw new Error("Archived attempt is missing.");
    const rows = decodeArchiveFrame<LogArchiveAttempt>(
      await this.range(location, archive.index, `${prefix}catalog.aflog`, page.offset, page.length),
    );
    const attempt = rows.find((row) => row.id === attemptId);
    if (!attempt) throw new Error("Archived attempt is missing.");
    return attempt.streams[stream].acknowledgedSequence;
  }
  private async archive(location: ArchivedBatchLocation): Promise<CachedArchive> {
    const key = `${location.archiveId}:${location.indexSha256}`;
    const cached = this.archives.get(key);
    if (cached) return cached;
    const opened = await this.objects.openRead(`${location.objectKey}.index.json`);
    if (opened.sizeBytes > 32 * 1024 * 1024)
      throw new Error("Archive object index exceeds its budget.");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of opened.content) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) throw new Error("Archive object index exceeds its budget.");
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    if (createHash("sha256").update(buffer).digest("hex") !== location.indexSha256)
      throw new Error("Archive object index checksum mismatch.");
    const index = indexSchema.parse(JSON.parse(buffer.toString("utf8")));
    if (Object.keys(index.entries).length > 100000)
      throw new Error("Archive entry index exceeds its budget.");
    const entry = { index, catalogs: new Map<string, LogArchiveCatalogFrame[]>() };
    if (this.archives.size >= 4) this.archives.delete(this.archives.keys().next().value!);
    this.archives.set(key, entry);
    return entry;
  }
  private async file(
    location: ArchivedBatchLocation,
    index: LogArchiveObjectIndex,
    path: string,
    maximum: number,
  ) {
    const entry = index.entries[path];
    if (!entry || entry.sizeBytes > maximum)
      throw new Error("Archive metadata is missing or oversized.");
    const parts: Buffer[] = [];
    for (let offset = 0; offset < entry.sizeBytes; offset += 8 * 1024 * 1024)
      parts.push(
        await this.range(
          location,
          index,
          path,
          offset,
          Math.min(8 * 1024 * 1024, entry.sizeBytes - offset),
        ),
      );
    return Buffer.concat(parts);
  }
  private async range(
    location: ArchivedBatchLocation,
    index: LogArchiveObjectIndex,
    path: string,
    offset: number,
    length: number,
  ) {
    const entry = index.entries[path];
    if (
      !entry ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      length < 0 ||
      offset + length > entry.sizeBytes ||
      entry.offset + offset + length > index.archiveBytes
    )
      throw new Error("Invalid archive object range.");
    if (!this.objects.readRange)
      throw new Error("Object store does not provide bounded range reads.");
    const content = await this.objects.readRange(location.objectKey, entry.offset + offset, length);
    if (content.length !== length) throw new Error("Archive object range is incomplete.");
    return Buffer.from(content);
  }
}
