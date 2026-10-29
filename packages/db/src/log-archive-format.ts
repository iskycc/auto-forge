import Database from "better-sqlite3";
import {
  archiveStreams,
  encodeArchiveFrame,
  hashArchiveChunk,
  type ArchivedLogChunk,
} from "./log-archive-codec";

import { createHash } from "node:crypto";
import { mkdir, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type {
  LogArchiveAttempt,
  LogArchiveCatalogFrame,
  LogArchiveStreamIndex,
  LogArchiveStream,
} from "@autoforge/contracts";
import type { LogArchiveRepository } from "@autoforge/application";
import type { AttemptLogStore, AsyncAttemptLogStore } from "./attempt-log-store";

const TARGET_FRAME_BYTES = 256 * 1024;

export async function writeBatchArchive(input: {
  directory: string;
  batchId: string;
  repository: LogArchiveRepository;
  logs: AttemptLogStore | AsyncAttemptLogStore;
  checkpoint(): Promise<void>;
}) {
  await mkdir(input.directory, { recursive: true });
  const handles: FileHandle[] = [];
  const catalogPath = join(input.directory, "catalog-staging.sqlite");
  let catalogDatabase: InstanceType<typeof Database> | undefined;
  try {
    for (const name of ["logs.aflog", "frames.bin", "catalog.aflog"]) {
      handles.push(await open(join(input.directory, name), "wx", 0o600));
    }
    const [logsFile, indexFile, catalogFile] = handles as [FileHandle, FileHandle, FileHandle];
    let logsOffset = 0,
      indexOffset = 0,
      catalogOffset = 0,
      attemptCount = 0,
      chunkCount = 0,
      rawBytes = 0;
    const catalogFrames: LogArchiveCatalogFrame[] = [];
    let pendingCatalog: LogArchiveAttempt[] = [];
    async function flushCatalog() {
      if (!pendingCatalog.length) return;
      const frame = encodeArchiveFrame(pendingCatalog);
      await writeAll(catalogFile, frame);
      catalogFrames.push({
        firstId: pendingCatalog[0]!.id,
        lastId: pendingCatalog.at(-1)!.id,
        offset: catalogOffset,
        length: frame.length,
        count: pendingCatalog.length,
      });
      catalogOffset += frame.length;
      pendingCatalog = [];
    }
    catalogDatabase = new Database(catalogPath);
    catalogDatabase.pragma("journal_mode=OFF");
    catalogDatabase.pragma("synchronous=OFF");
    catalogDatabase.exec(
      "CREATE TABLE attempts(id TEXT PRIMARY KEY,payload TEXT NOT NULL) WITHOUT ROWID",
    );
    const insert = catalogDatabase.prepare("INSERT INTO attempts(id,payload) VALUES(?,?)");
    const appendPage = catalogDatabase.transaction((rows: Omit<LogArchiveAttempt, "streams">[]) => {
      for (const row of rows) insert.run(row.id, JSON.stringify(row));
    });
    let sourceCursor = "";
    for (;;) {
      await input.checkpoint();
      const page = await input.repository.attempts(input.batchId, sourceCursor);
      appendPage(page);
      const last = page.at(-1);
      if (last) sourceCursor = `${last.executionRunId}/${last.id}`;
      if (page.length < 100) break;
    }
    let cursor = "";
    for (;;) {
      const attempts = (
        catalogDatabase
          .prepare("SELECT payload FROM attempts WHERE id>? ORDER BY id LIMIT 100")
          .all(cursor) as { payload: string }[]
      ).map((row) => JSON.parse(row.payload) as Omit<LogArchiveAttempt, "streams">);
      for (const attempt of attempts) {
        await input.checkpoint();
        const streams = {} as Record<LogArchiveStream, LogArchiveStreamIndex>;
        for (const stream of archiveStreams) {
          const index: LogArchiveStreamIndex = {
            sourceHash: "",
            indexOffset,
            frameCount: 0,
            chunkCount: 0,
            rawBytes: 0,
            acknowledgedSequence: await input.logs.acknowledgedSequence(
              input.batchId,
              attempt.id,
              stream,
            ),
          };
          const sourceHash = createHash("sha256");
          let pending: ArchivedLogChunk[] = [];
          let pendingBytes = 0;
          let after = -1;
          const flush = async () => {
            if (!pending.length) return;
            const frame = encodeArchiveFrame(pending);
            await writeAll(logsFile, frame);
            const descriptor = Buffer.alloc(32);
            descriptor.writeBigUInt64LE(BigInt(logsOffset));
            descriptor.writeBigUInt64LE(BigInt(pending[0]!.sequence), 8);
            descriptor.writeBigUInt64LE(BigInt(pending.at(-1)!.sequence), 16);
            descriptor.writeUInt32LE(frame.length, 24);
            descriptor.writeUInt32LE(frame.readUInt32LE(12), 28);
            await writeAll(indexFile, descriptor);
            logsOffset += frame.length;
            indexOffset += 32;
            index.frameCount++;
            pending = [];
            pendingBytes = 0;
            await input.checkpoint();
          };
          for (;;) {
            const page = await input.logs.listChunks({
              batchId: input.batchId,
              attemptId: attempt.id,
              stream,
              afterSequence: after,
              limit: 32,
            });
            for (const chunk of page.items) {
              if (chunk.sequence <= after || chunk.stream !== stream)
                throw new Error("Source log sequences are not strictly ordered.");
              const bytes = Buffer.byteLength(JSON.stringify(chunk));
              if (pending.length && pendingBytes + bytes > TARGET_FRAME_BYTES) await flush();
              hashArchiveChunk(sourceHash, chunk);
              index.chunkCount++;
              index.rawBytes += Buffer.byteLength(chunk.content);
              chunkCount++;
              rawBytes += Buffer.byteLength(chunk.content);
              pending.push({ ...chunk, attemptId: attempt.id, frameIndex: index.frameCount });
              pendingBytes += bytes;
              after = chunk.sequence;
            }
            if (!page.hasMore) break;
            if (!page.items.length) throw new Error("Source log cursor made no progress.");
          }
          await flush();
          index.sourceHash = sourceHash.digest("hex");
          streams[stream] = index;
        }
        pendingCatalog.push({ ...attempt, streams });
        attemptCount++;
        cursor = attempt.id;
        if (pendingCatalog.length >= 100) await flushCatalog();
      }
      if (attempts.length < 100) break;
    }
    await flushCatalog();
    await writeFile(join(input.directory, "catalog.index.json"), JSON.stringify(catalogFrames), {
      mode: 0o600,
      flag: "wx",
    });
    return { attemptCount, chunkCount, rawBytes };
  } finally {
    try {
      catalogDatabase?.close();
    } finally {
      const cleanup = await Promise.allSettled([
        rm(catalogPath, { force: true }),
        ...handles.map((handle) => handle.close()),
      ]);
      const failures = cleanup.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Failed to release archive staging files.",
        );
      }
    }
  }
}

async function writeAll(handle: FileHandle, content: Buffer): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const written = await handle.write(content, offset, content.length - offset);
    if (!written.bytesWritten) throw new Error("Archive file write made no progress.");
    offset += written.bytesWritten;
  }
}
